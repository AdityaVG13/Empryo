import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

const failingSource =
  'import { externalValue } from "example-package";\nexport function failIndex() { return externalValue; }\n';

describe("RepoMap scan file atomicity", () => {
  let dir: string;
  let repoMap: RepoMap;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rm-atomic-"));
    repoMap = new RepoMap(dir);
  });

  afterEach(async () => {
    await repoMap.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function failRefInsertion() {
    // @ts-expect-error -- inject a real SQLite failure after earlier indexing writes
    const db = repoMap.db;
    db.run(
      "CREATE TRIGGER fail_ref BEFORE INSERT ON refs WHEN NEW.name = 'failIndex' BEGIN SELECT RAISE(ABORT, 'injected indexing failure'); END",
    );
    return db;
  }

  test("cold scan rolls back a failed file and commits healthy files with sync enabled", async () => {
    writeFileSync(join(dir, "failed.ts"), failingSource);
    writeFileSync(join(dir, "healthy.ts"), "export function healthy() { return 1; }\n");
    const db = failRefInsertion();
    const errors: string[] = [];
    const scanSync: number[] = [];
    repoMap.onError = (error) => errors.push(error);
    repoMap.onProgress = () => {
      if (db.inTransaction) {
        scanSync.push(
          db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous,
        );
      }
    };

    await repoMap.scan();
    expect(errors.some((error) => error.includes("Failed to index failed.ts"))).toBe(true);
    expect(db.query("SELECT path FROM files ORDER BY path").all()).toEqual([
      { path: "healthy.ts" },
    ]);
    expect(repoMap.getFileSymbols("healthy.ts").map((symbol) => symbol.name)).toEqual(["healthy"]);
    expect(repoMap.getFileSymbols("failed.ts")).toEqual([]);
    expect(db.query("SELECT * FROM external_imports").all()).toEqual([]);
    expect(
      db.query("SELECT * FROM trigrams WHERE file_id NOT IN (SELECT id FROM files)").all(),
    ).toEqual([]);
    // @ts-expect-error -- failed file must not remain in the import-resolution cache
    expect(repoMap.fileIdByPath.has("failed.ts")).toBe(false);
    expect(scanSync.length).toBeGreaterThan(0);
    expect(scanSync.every((sync) => sync === 1)).toBe(true); // NORMAL
  });

  test("a failed source read leaves the prior index untouched", async () => {
    const file = join(dir, "failed.ts");
    writeFileSync(file, "export function priorVersion() { return 1; }\n");
    await repoMap.scan();
    const before = repoMap.getFileSymbols("failed.ts");
    writeFileSync(file, failingSource);
    // @ts-expect-error -- simulate the collected path becoming unreadable before indexing
    const index = repoMap.indexFile.bind(repoMap);
    // @ts-expect-error -- spying a private method for a deterministic failed read
    const indexSpy = spyOn(repoMap, "indexFile").mockImplementation((_, ...args) => {
      index(join(dir, "missing.ts"), ...args);
    });
    try {
      await repoMap.scan();
      expect(repoMap.getFileSymbols("failed.ts")).toEqual(before);
    } finally {
      indexSpy.mockRestore();
    }
  });

  test("incremental scan preserves a failed file's prior index", async () => {
    const failed = join(dir, "failed.ts");
    writeFileSync(failed, "export function priorVersion() { return 1; }\n");
    await repoMap.scan();
    const db = failRefInsertion();
    const beforeFile = db
      .query("SELECT id, mtime_ms, size_bytes FROM files WHERE path = 'failed.ts'")
      .get();
    const beforeSymbols = repoMap.getFileSymbols("failed.ts");
    const beforeTrigrams = db.query("SELECT * FROM trigrams ORDER BY trigram, file_id").all();
    const errors: string[] = [];
    repoMap.onError = (error) => errors.push(error);
    writeFileSync(failed, failingSource);
    writeFileSync(join(dir, "healthy.ts"), "export function healthy() { return 1; }\n");

    await repoMap.scan();
    expect(errors.some((error) => error.includes("Failed to index failed.ts"))).toBe(true);
    expect(
      db.query("SELECT id, mtime_ms, size_bytes FROM files WHERE path = 'failed.ts'").get(),
    ).toEqual(beforeFile);
    expect(repoMap.getFileSymbols("failed.ts")).toEqual(beforeSymbols);
    expect(
      db
        .query(
          "SELECT * FROM trigrams WHERE file_id = (SELECT id FROM files WHERE path = 'failed.ts') ORDER BY trigram, file_id",
        )
        .all(),
    ).toEqual(beforeTrigrams);
    expect(db.query("SELECT * FROM external_imports").all()).toEqual([]);
    expect(repoMap.getFileSymbols("healthy.ts").map((symbol) => symbol.name)).toEqual(["healthy"]);
  });
});
