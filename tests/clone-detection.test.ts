import { describe, expect, test } from "bun:test";
import {
  computeMinHash,
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
