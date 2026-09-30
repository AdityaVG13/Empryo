import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queryCacheSize,
  TreeSitterBackend,
} from "../src/core/intelligence/backends/tree-sitter.js";

const TMP = join(tmpdir(), `ts-query-cache-${Date.now()}`);

const backend = new TreeSitterBackend();

function writeTemp(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);

  return path;
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  await backend.initialize(TMP);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("tree-sitter query cache", () => {
  it("compiles a query once per (grammar, source) and reuses it", async () => {
    const a = writeTemp(
      "a.ts",
      `import { z } from "./b.js";
export function alpha() { return 1; }
`,
    );

    const b = writeTemp(
      "b.ts",
      `export function beta() { return 2; }
`,
    );

    const outlineA1 = await backend.getFileOutline(a);
    const sizeAfterA = queryCacheSize();
    expect(sizeAfterA).toBeGreaterThan(0);

    const outlineB = await backend.getFileOutline(b);
    expect(queryCacheSize()).toBe(sizeAfterA);

    const outlineA2 = await backend.getFileOutline(a);
    expect(queryCacheSize()).toBe(sizeAfterA);
    expect(outlineA2).toEqual(outlineA1);
    expect(outlineA1?.symbols.some((s) => s.name === "alpha")).toBe(true);
    expect(outlineB?.symbols.some((s) => s.name === "beta")).toBe(true);
  });

  it("keeps findImports/findExports/findSymbols isomorphic across reuse", async () => {
    const f = writeTemp(
      "iso.ts",
      `import { z } from "./z.js";
export function alpha() { return 1; }
export class Beta {}
`,
    );

    const imports1 = await backend.findImports(f);
    const imports2 = await backend.findImports(f);
    expect(imports2).toEqual(imports1);
    expect(imports1?.some((i) => i.source === "./z.js")).toBe(true);

    const exports1 = await backend.findExports(f);
    const exports2 = await backend.findExports(f);
    expect(exports2).toEqual(exports1);
    expect(exports1?.some((e) => e.name === "alpha")).toBe(true);

    const symbols1 = await backend.findSymbols(f);
    const symbols2 = await backend.findSymbols(f);
    expect(symbols2).toEqual(symbols1);
    expect(symbols1?.some((s) => s.name === "Beta")).toBe(true);
  });

  it("keys cache by grammar string, not language object identity", async () => {
    const py = writeTemp("mod.py", "def foo():\n    pass\n");
    const outline1 = await backend.getFileOutline(py);
    const afterFirst = queryCacheSize();

    // A second backend loads its own Language object for the same grammar —
    // the compiled query must be shared, not recompiled.
    const backend2 = new TreeSitterBackend();
    await backend2.initialize(TMP);
    const outline2 = await backend2.getFileOutline(py);
    expect(queryCacheSize()).toBe(afterFirst);
    expect(outline2).toEqual(outline1);
    expect(outline1?.symbols.some((s) => s.name === "foo")).toBe(true);
  });

  it("reuses one parse tree for outline + shape hashes", async () => {
    const f = writeTemp(
      "shape.ts",
      `export function alpha(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      acc += i;
    } else {
      acc -= i;
    }
  }
  if (acc < 0) {
    return -acc;
  }
  return acc;
}
`,
    );

    // @ts-expect-error — spying a private method for test
    const parseSpy = spyOn(TreeSitterBackend.prototype, "parseFileSync");

    try {
      const combined = await backend.getFileOutline(f, { shapeHashes: true });
      const standalone = await backend.getShapeHashes(f);
      const plain = await backend.getFileOutline(f);

      expect(combined?.symbols).toEqual(plain?.symbols);
      expect(combined?.imports).toEqual(plain?.imports);
      expect(combined?.exports).toEqual(plain?.exports);
      expect("shapeHashes" in (plain ?? {})).toBe(false);
      expect(combined?.shapeHashes).toEqual(standalone);
      expect((combined?.shapeHashes?.length ?? 0) + (standalone?.length ?? 0)).toBeGreaterThan(0);
      // One WASM parse serves all three calls via the tree cache.
      expect(parseSpy).toHaveBeenCalledTimes(1);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("disk outlines parse and cache the source snapshot read for the outline", async () => {
    const first = "export function firstSnapshot() { return 1; }\n";
    const later = "export function laterSnapshot() { return 2; }\n";
    const f = writeTemp("snapshot.ts", first);
    // @ts-expect-error -- spying a private reader to simulate a file changing between reads
    const readSpy = spyOn(backend, "readFileContent");

    try {
      readSpy.mockResolvedValueOnce(first).mockResolvedValue(later);
      const outline = await backend.getFileOutline(f);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect([...new Set(outline?.symbols.map((s) => s.name))]).toEqual(["firstSnapshot"]);
      expect(outline?.exports.map((e) => e.name)).toEqual(["firstSnapshot"]);

      // The next call must observe the new content, not reuse the old cached tree.
      const updated = await backend.getFileOutline(f);
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect([...new Set(updated?.symbols.map((s) => s.name))]).toEqual(["laterSnapshot"]);
      expect(updated?.exports.map((e) => e.name)).toEqual(["laterSnapshot"]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("outlineFromContent returns null when the grammar is not loaded", () => {
    const fresh = new TreeSitterBackend();

    expect(fresh.outlineFromContent(join(TMP, "unloaded.ts"), "export const a = 1;\n")).toBeNull();
  });
});
