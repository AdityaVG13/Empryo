import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { RepoMap } from "../src/core/intelligence/repo-map.js";

describe("RepoMap flushReindex grammar loading", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rm-flush-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("warm-boot edit keeps symbols (reindex loads grammars)", async () => {
    const file = join(dir, "a.ts");
    writeFileSync(file, "export function alpha(): number { return 1; }\n");

    const rm1 = new RepoMap(dir);
    await rm1.scan();
    expect(rm1.getFileSymbols("a.ts").map((s) => s.name)).toEqual(["alpha"]);
    await rm1.close();

    // Warm boot: nothing to index, so the scan loads no grammars.
    const rm2 = new RepoMap(dir);
    await rm2.scan();

    // Edit the file, then let the debounced reindex run.
    writeFileSync(
      file,
      "export function alpha(): number { return 2; }\nexport function beta(): number { return 3; }\n",
    );
    rm2.onFileChanged(file);

    const names = await pollSymbols(rm2, "a.ts");
    expect(names).toEqual(["alpha", "beta"]);
    await rm2.close();
  }, 15_000);

  /** flushReindex is debounced + async — poll until the edit lands or time out. */
  async function pollSymbols(rm: RepoMap, relPath: string): Promise<string[]> {
    const deadline = Date.now() + 10_000;

    for (;;) {
      const names = rm.getFileSymbols(relPath).map((s) => s.name);
      // "beta" only exists after the debounced reindex runs; stale ["alpha"]
      // (or wiped []) means keep waiting.
      if (names.includes("beta") || Date.now() > deadline) return names;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});
