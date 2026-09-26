/**
 * buildTools must reuse ContextManager's MemoryManager.
 * Constructing a fresh one per turn opens two extra SQLite DBs (WAL, cache, mmap).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SOULFORGE_NO_REPOMAP = "1";

import { MockLanguageModelV3 } from "ai/test";

import { createForgeAgent } from "../src/core/agents/forge.js";
import { ContextManager } from "../src/core/context/manager.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { buildTools } from "../src/core/tools/index.js";

type MemoryTool = {
  execute?: (args: Record<string, string>) => Promise<{ success: boolean; output: string }>;
};

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

function configDirMemoryDb(home: string): string {
  return process.platform === "win32"
    ? join(home, "SoulForge", "memory.db")
    : join(home, ".soulforge", "memory.db");
}

function makeTmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `bt-mm-${label}-`));
}

describe("buildTools memoryManager reuse", () => {
  let dir: string;
  let mm: MemoryManager;
  let restoreHome: () => void;

  beforeEach(() => {
    dir = makeTmp("reuse");
    restoreHome = isolateConfigDir(dir);
    mm = new MemoryManager(dir, join(dir, "global"));
  });

  afterEach(() => {
    mm?.close();
    restoreHome?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the passed MemoryManager instance (write + sqlite)", async () => {
    const writeSpy = spyOn(mm, "write");
    const tools = buildTools(dir, undefined, undefined, { memoryManager: mm });
    const memory = (tools as { memory: MemoryTool }).memory;
    expect(memory.execute).toBeFunction();

    const result = await memory.execute!({
      action: "write",
      summary: "build-tools-reuse-marker",
      details: "shared manager",
      category: "pref",
    });

    expect(result.success).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]?.[0]).toBe("project");
    expect(writeSpy.mock.calls[0]?.[1]).toMatchObject({
      summary: "build-tools-reuse-marker",
      details: "shared manager",
    });
    expect(mm.list("project").some((r) => r.summary === "build-tools-reuse-marker")).toBe(true);
    writeSpy.mockRestore();
  });

  it("does not construct a new MemoryManager when one is passed", () => {
    buildTools(dir, undefined, undefined, { memoryManager: mm });
    expect(existsSync(configDirMemoryDb(join(dir, "home")))).toBe(false);
  });

  it("closing the passed manager closes the tool's DBs", async () => {
    const local = new MemoryManager(dir, join(dir, "global-close"));
    const tools = buildTools(dir, undefined, undefined, { memoryManager: local });
    const memory = (tools as { memory: MemoryTool }).memory;
    local.close();

    const result = await memory.execute!({ action: "list" });

    expect(result.success).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
  });
});

describe("buildTools without memoryManager", () => {
  it("opens project + global sqlite files (fallback constructor)", () => {
    const isolated = makeTmp("omit");
    const restoreHome = isolateConfigDir(isolated);

    try {
      buildTools(isolated);
      expect(existsSync(join(isolated, ".soulforge", "memory.db"))).toBe(true);
      expect(existsSync(configDirMemoryDb(join(isolated, "home")))).toBe(true);
    } finally {
      restoreHome();
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("createForgeAgent memoryManager wiring", () => {
  let tmp: string;
  let cm: ContextManager;
  let restoreHome: () => void;

  beforeEach(() => {
    tmp = makeTmp("forge");
    restoreHome = isolateConfigDir(tmp);
    cm = new ContextManager(tmp);
  });

  afterEach(() => {
    cm?.dispose();
    restoreHome?.();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes contextManager.getMemoryManager() into buildTools", async () => {
    const mm = cm.getMemoryManager();
    const writeSpy = spyOn(mm, "write");
    const model = new MockLanguageModelV3({ modelId: "anthropic/claude-sonnet-4-6" });

    // @ts-expect-error — test-only structural view of the agent's toolset
    const agent: { tools: { memory?: MemoryTool } } = createForgeAgent({
      model,
      contextManager: cm,
    });

    const memory = agent.tools.memory;
    expect(memory?.execute).toBeFunction();

    const result = await memory!.execute!({
      action: "write",
      summary: "forge-reuse-marker",
      details: "wired from contextManager",
      category: "pref",
    });

    expect(result.success).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(mm.list("project").some((r) => r.summary === "forge-reuse-marker")).toBe(true);
    writeSpy.mockRestore();
  });
});
