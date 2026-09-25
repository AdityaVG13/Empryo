import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
    const before = queryCacheSize();
    const outline1 = await backend.getFileOutline(py);
    const after = queryCacheSize();
    expect(after).toBeGreaterThan(before);

    const outline2 = await backend.getFileOutline(py);
    expect(queryCacheSize()).toBe(after);
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

    const combined = await backend.getFileOutline(f, { shapeHashes: true });
    const standalone = await backend.getShapeHashes(f);
    const plain = await backend.getFileOutline(f);

    expect(combined?.symbols).toEqual(plain?.symbols);
    expect(combined?.imports).toEqual(plain?.imports);
    expect(combined?.exports).toEqual(plain?.exports);
    expect("shapeHashes" in (plain ?? {})).toBe(false);
    expect(combined?.shapeHashes).toEqual(standalone);
    expect((combined?.shapeHashes?.length ?? 0) + (standalone?.length ?? 0)).toBeGreaterThan(0);
  });
});
