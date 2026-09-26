import { describe, expect, test } from "bun:test";
import {
  computeMinHash,
  hashTokensU32,
  jaccardSimilarity,
  tokenize,
} from "../src/core/intelligence/clone-detection.js";

function ids(prefix: string, n: number): string[] {
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) out[i] = `${prefix}${i}`;
  return out;
}

describe("tokenize", () => {
  test("maps strings to $S and numbers to $N", () => {
    expect(tokenize(`x = "hello" + 42`)).toEqual(["$I", "=", "$S", "+", "$N"]);
    expect(tokenize("y = 0xFF + 1.5e2")).toEqual(["$I", "=", "$N", "+", "$N"]);
    expect(tokenize("z = 'a' + `b`")).toEqual(["$I", "=", "$S", "+", "$S"]);
  });

  test("keeps keywords and maps other identifiers to $I", () => {
    expect(tokenize("if (foo) return 1")).toEqual(["if", "(", "$I", ")", "return", "$N"]);
  });
});

describe("hashTokensU32", () => {
  test("interned tokens match Bun.hash.xxHash32 of the same string", () => {
    const interned = ["$I", "$S", "$N", "if", "return", "function", "None"];
    const hashed = hashTokensU32(interned);
    for (let i = 0; i < interned.length; i++) {
      expect(hashed[i]).toBe(Bun.hash.xxHash32(interned[i] as string) >>> 0);
    }
  });

  test("non-interned tokens still hash with xxHash32", () => {
    expect(hashTokensU32(["="])[0]).toBe(Bun.hash.xxHash32("=") >>> 0);
    expect(hashTokensU32(["unique_ident_xyz"])[0]).toBe(
      Bun.hash.xxHash32("unique_ident_xyz") >>> 0,
    );
  });
});

describe("computeMinHash", () => {
  test("returns null for tiny inputs", () => {
    expect(computeMinHash([])).toBeNull();
    expect(computeMinHash(["a"])).toBeNull();
    expect(computeMinHash(["a", "b", "c", "d"])).toBeNull();
    expect(computeMinHash(["a", "b", "c", "d", "e"])).not.toBeNull();
  });

  test("identical tokens produce equal signatures", () => {
    const tokens = ids("tok", 40);
    const a = computeMinHash(tokens);
    const b = computeMinHash(tokens.slice());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toEqual(b);
    expect(jaccardSimilarity(a!, b!)).toBe(1);
  });

  test("tokenize volume tokens ($I/$S/$N/keywords) stay deterministic", () => {
    const src = 'if (foo) { return "bar" + 42; } else { function baz() { return null; } }';
    const tokens = tokenize(src);
    expect(tokens).toContain("$I");
    expect(tokens).toContain("$S");
    expect(tokens).toContain("$N");
    expect(tokens).toContain("if");
    const a = computeMinHash(tokens);
    const b = computeMinHash(tokens.slice());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toEqual(b);
    expect(jaccardSimilarity(a!, b!)).toBe(1);
  });

  test("one-token edit of a 40-token stream keeps Jaccard > 0.5", () => {
    const aTok = ids("tok", 40);
    const bTok = aTok.slice();
    bTok[17] = "mutated";
    const a = computeMinHash(aTok)!;
    const b = computeMinHash(bTok)!;
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.5);
  });

  test("disjoint keyword-free identifiers stay Jaccard < 0.4", () => {
    const a = computeMinHash(ids("alpha", 40))!;
    const b = computeMinHash(ids("omega", 40))!;
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.4);
  });
});
