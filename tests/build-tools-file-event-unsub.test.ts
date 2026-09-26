/**
 * buildTools must replace file-event listeners for the same tabId
 * instead of stacking them on every rebuild.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SOULFORGE_NO_REPOMAP = "1";

import { MemoryManager } from "../src/core/memory/manager.js";
import { emitFileEdited, fileEventListenerCount } from "../src/core/tools/file-events.js";
import { buildTools } from "../src/core/tools/index.js";

type ReadTool = {
  execute?: (args: { files: Array<{ path: string }> }) => Promise<{
    success: boolean;
    output: string;
  }>;
};

type ToolSet = ReturnType<typeof buildTools>;

function readToolOf(tools: ToolSet): ReadTool {
  return tools.read;
}

function isolateConfigDir(root: string): () => void {
  const home = join(root, "home");
  const prevHome = process.env.HOME;
  const prevLocal = process.env.LOCALAPPDATA;
  process.env.HOME = home;
  process.env.LOCALAPPDATA = home;

  return () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;

    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
  };
}

function makeTmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bt-fe-${label}-`));
}

describe("buildTools file-event listener reuse", () => {
  let dir: string;
  let mm: MemoryManager;
  let restoreHome: () => void;

  beforeEach(() => {
    dir = makeTmp("unsub");
    restoreHome = isolateConfigDir(dir);
    mm = new MemoryManager(dir, join(dir, "global"));
  });

  afterEach(() => {
    mm?.close();
    restoreHome?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not grow edit listeners when rebuilt with the same tabId", () => {
    const tabId = "tab-reuse";
    buildTools(dir, undefined, undefined, { memoryManager: mm, tabId });
    const afterFirst = fileEventListenerCount();

    buildTools(dir, undefined, undefined, { memoryManager: mm, tabId });
    const afterSecond = fileEventListenerCount();

    expect(afterSecond.edit).toBe(afterFirst.edit);
    expect(afterSecond.cacheReset).toBe(afterFirst.cacheReset);
  });

  it("keeps a separate listener pair per tabId", () => {
    buildTools(dir, undefined, undefined, { memoryManager: mm, tabId: "tab-a" });
    const afterA = fileEventListenerCount();

    buildTools(dir, undefined, undefined, { memoryManager: mm, tabId: "tab-b" });
    const afterB = fileEventListenerCount();

    expect(afterB.edit).toBe(afterA.edit + 1);
    expect(afterB.cacheReset).toBe(afterA.cacheReset + 1);

    buildTools(dir, undefined, undefined, { memoryManager: mm, tabId: "tab-a" });
    const afterARebuild = fileEventListenerCount();
    expect(afterARebuild.edit).toBe(afterB.edit);
    expect(afterARebuild.cacheReset).toBe(afterB.cacheReset);
  });

  it("keeps every tab-less tool set invalidated (no shared-key clobber)", async () => {
    const a = buildTools(dir, undefined, undefined, { memoryManager: mm });
    const afterFirst = fileEventListenerCount();

    const b = buildTools(dir, undefined, undefined, { memoryManager: mm });
    const afterSecond = fileEventListenerCount();
    expect(afterSecond.edit).toBe(afterFirst.edit);
    expect(afterSecond.cacheReset).toBe(afterFirst.cacheReset);

    // Both sets read (and cache) the same file.
    const note = join(dir, "note.txt");
    writeFileSync(note, "version one\n");
    const readA = readToolOf(a);
    const readB = readToolOf(b);
    expect((await readA.execute!({ files: [{ path: note }] })).output).toContain("version one");
    expect((await readB.execute!({ files: [{ path: note }] })).output).toContain("version one");

    // An edit must invalidate both sets — neither may serve the stale stub.
    writeFileSync(note, "version two\n");
    emitFileEdited(note, "version two\n");
    expect((await readA.execute!({ files: [{ path: note }] })).output).toContain("version two");
    expect((await readB.execute!({ files: [{ path: note }] })).output).toContain("version two");
  });
});
