import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { RepoMap } from "../src/core/intelligence/repo-map.js";
import type { Language } from "../src/core/intelligence/types.js";

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

  test("cold scan aborts without partial rows and retries with sync enabled", async () => {
    writeFileSync(join(dir, "failed.ts"), failingSource);
    writeFileSync(join(dir, "healthy.ts"), "export function healthy() { return 1; }\n");
    const db = failRefInsertion();
    const errors: string[] = [];
    const scanSync: number[] = [];
    repoMap.onError = (error) => errors.push(error);
    const indexer = repoMap as unknown as {
      indexFile: (path: string, relPath: string, mtime: number, language: Language, size?: number) => void;
    };
    const index = indexer.indexFile.bind(indexer);
    const indexSpy = spyOn(indexer, "indexFile").mockImplementation((...args) => {
      scanSync.push(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous);
      index(...args);
    });
    try {
      await expect(repoMap.scan()).rejects.toThrow("injected indexing failure");
    } finally {
      indexSpy.mockRestore();
    }
    expect(errors.some((error) => error.includes("Failed to index failed.ts"))).toBe(true);
    for (const table of ["files", "symbols", "refs", "external_imports", "trigrams", "calls", "edges"]) {
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    expect(repoMap.getFileSymbols("failed.ts")).toEqual([]);
    expect(db.query("SELECT * FROM external_imports").all()).toEqual([]);
    expect(
      db.query("SELECT * FROM trigrams WHERE file_id NOT IN (SELECT id FROM files)").all(),
    ).toEqual([]);
    // @ts-expect-error -- failed file must not remain in the import-resolution cache
    expect(repoMap.fileIdByPath.has("failed.ts")).toBe(false);
    expect(scanSync.length).toBeGreaterThan(0);
    expect(scanSync.every((sync) => sync === 1)).toBe(true); // NORMAL
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    db.run("DROP TRIGGER fail_ref");
    await repoMap.scan();
    expect(repoMap.getFileSymbols("healthy.ts").map((symbol) => symbol.name)).toEqual(["healthy"]);
    expect(repoMap.getFileSymbols("failed.ts").map((symbol) => symbol.name)).toEqual(["failIndex"]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("a failed source read leaves the prior index untouched", async () => {
    const file = join(dir, "failed.ts");
    writeFileSync(file, "export function priorVersion() { return 1; }\n");
    await repoMap.scan();
    const before = repoMap.getFileSymbols("failed.ts");
    writeFileSync(file, failingSource);
    const indexer = repoMap as unknown as {
      indexFile: (path: string, relPath: string, mtime: number, language: Language, size?: number) => void;
    };
    const index = indexer.indexFile.bind(indexer);
    const indexSpy = spyOn(indexer, "indexFile").mockImplementation((_, ...args) => {
      index(join(dir, "missing.ts"), ...args);
    });
    try {
      await expect(repoMap.scan()).rejects.toThrow("missing.ts");
      expect(repoMap.getFileSymbols("failed.ts")).toEqual(before);
    } finally {
      indexSpy.mockRestore();
    }
  });

  test("indexes calls from single-line functions", async () => {
    writeFileSync(join(dir, "callee.ts"), "export function callee() { return 1; }\n");
    writeFileSync(
      join(dir, "caller.ts"),
      'import { callee } from "./callee";\nexport function caller() { return callee(); }\n',
    );
    await repoMap.scan();
    // @ts-expect-error -- inspect the indexed call graph
    const db = repoMap.db;
    expect(db.query("SELECT callee_name, line FROM calls").all()).toEqual([{ callee_name: "callee", line: 2 }]);
  });

  test("excludes synthetic re-exports without excluding real line-one callers", async () => {
    writeFileSync(join(dir, "callee.ts"), "export function callee() { return 1; }\n");
    writeFileSync(join(dir, "defs.ts"), "export function forwarded() { return 0; }\n");
    writeFileSync(
      join(dir, "barrel.ts"),
      'import { callee } from "./callee"; export function realCaller() { return callee(); }\nexport * from "./defs";\n',
    );
    await repoMap.scan();
    // @ts-expect-error -- inspect synthetic markers and function-level calls
    const db = repoMap.db;
    const synthetic = db
      .query(
        "SELECT s.line, s.end_line, s.is_exported, s.signature FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'barrel.ts' AND s.name = 'forwarded'",
      )
      .get();
    expect(synthetic).toEqual({ line: 1, end_line: 1, is_exported: 1, signature: null });
    expect(
      db
        .query(
          "SELECT s.name AS caller, c.callee_name, c.line FROM calls c JOIN symbols s ON s.id = c.caller_symbol_id JOIN files f ON f.id = s.file_id WHERE f.path = 'barrel.ts' ORDER BY s.name",
        )
        .all(),
    ).toEqual([{ caller: "realCaller", callee_name: "callee", line: 1 }]);
  });

  test("preserves calls and symbols when a changed caller fails indexing", async () => {
    writeFileSync(join(dir, "callee.ts"), "export function callee() { return 1; }\n");
    writeFileSync(
      join(dir, "caller.ts"),
      'import { callee } from "./callee";\nexport function caller() {\n  return callee();\n}\n',
    );
    await repoMap.scan();
    const db = failRefInsertion();
    const beforeCalls = db.query("SELECT * FROM calls ORDER BY caller_symbol_id, callee_file_id").all();
    const beforeSymbols = repoMap.getFileSymbols("caller.ts");
    expect(beforeCalls.length).toBeGreaterThan(0);
    const scanResults: boolean[] = [];
    repoMap.onScanComplete = (success) => scanResults.push(success);
    writeFileSync(
      join(dir, "caller.ts"),
      'import { callee } from "./callee";\nexport function failIndex() {\n  return 42;\n}\n',
    );
    let scanError: unknown;
    try {
      await repoMap.scan();
    } catch (error) {
      scanError = error;
    }
    expect(db.query("SELECT * FROM calls ORDER BY caller_symbol_id, callee_file_id").all()).toEqual(beforeCalls);
    expect(repoMap.getFileSymbols("caller.ts")).toEqual(beforeSymbols);
    expect(scanError).toBeInstanceOf(Error);
    expect(scanResults).toEqual([false]);

    db.run("DROP TRIGGER fail_ref");
    await repoMap.scan();
    expect(repoMap.getFileSymbols("caller.ts").map((symbol) => symbol.name)).toEqual(["failIndex"]);
    expect(db.query("SELECT * FROM calls").all()).toEqual([]);
    expect(scanResults).toEqual([false, true]);
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

    await expect(repoMap.scan()).rejects.toThrow("injected indexing failure");
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
    expect(repoMap.getFileSymbols("healthy.ts")).toEqual([]);
    db.run("DROP TRIGGER fail_ref");
    await repoMap.scan();
    expect(repoMap.getFileSymbols("healthy.ts").map((symbol) => symbol.name)).toEqual(["healthy"]);
    expect(repoMap.getFileSymbols("failed.ts").map((symbol) => symbol.name)).toEqual(["failIndex"]);
  });
});
