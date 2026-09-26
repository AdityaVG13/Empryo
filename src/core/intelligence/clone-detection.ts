const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "class",
  "extends",
  "implements",
  "interface",
  "enum",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "yield",
  "import",
  "export",
  "from",
  "default",
  "static",
  "public",
  "private",
  "protected",
  "abstract",
  "override",
  "readonly",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "this",
  "super",
  "def",
  "self",
  "fn",
  "pub",
  "mut",
  "impl",
  "struct",
  "trait",
  "mod",
  "use",
  "crate",
  "match",
  "loop",
  "func",
  "go",
  "chan",
  "select",
  "defer",
  "range",
  "type",
  "package",
  "raise",
  "except",
  "pass",
  "lambda",
  "with",
  "as",
  "is",
  "not",
  "and",
  "or",
  "None",
  "True",
  "False",
]);

// TOKEN_RE vocabulary, scanned by char index (no matchAll / exec match objects):
// /[a-zA-Z_$]\w*|0[xXbBoO][\da-fA-F_]+|\d[\d_.]*(?:[eE][+-]?\d+)?[fFdDlLuU]?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s\w]/g
const TOK_I = "$I";

const TOK_S = "$S";

const TOK_N = "$N";

let kwMinLen = 32;

let kwMaxLen = 0;

for (const kw of KEYWORDS) {
  const len = kw.length;

  if (len < kwMinLen) kwMinLen = len;

  if (len > kwMaxLen) kwMaxLen = len;
}

const KW_MIN_LEN = kwMinLen;

const KW_MAX_LEN = kwMaxLen;

export function tokenize(source: string): string[] {
  const n = source.length;
  const tokens: string[] = [];
  let i = 0;

  while (i < n) {
    const c = source.charCodeAt(i);

    // \s (ASCII fast path, then Unicode WhiteSpace / LineTerminator)
    if (c <= 32) {
      if (c === 32 || (c >= 9 && c <= 13)) {
        i++;
        continue;
      }
    } else if (c >= 0xa0) {
      if (
        c === 0xa0 ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000 ||
        c === 0xfeff
      ) {
        i++;
        continue;
      }
    }

    // [a-zA-Z_$]\w*
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
      const start = i++;

      while (i < n) {
        const d = source.charCodeAt(i);

        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) {
          i++;
        } else break;
      }

      const len = i - start;

      if (len < KW_MIN_LEN || len > KW_MAX_LEN) {
        tokens.push(TOK_I);
      } else {
        const ident = source.slice(start, i);
        tokens.push(KEYWORDS.has(ident) ? ident : TOK_I);
      }

      continue;
    }

    // 0[xXbBoO][\da-fA-F_]+  |  \d[\d_.]*(?:[eE][+-]?\d+)?[fFdDlLuU]?
    if (c >= 48 && c <= 57) {
      if (c === 48 && i + 2 < n) {
        const p = source.charCodeAt(i + 1);

        if (p === 120 || p === 88 || p === 98 || p === 66 || p === 111 || p === 79) {
          const d = source.charCodeAt(i + 2);

          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102) || d === 95) {
            i += 3;

            while (i < n) {
              const h = source.charCodeAt(i);

              if (
                (h >= 48 && h <= 57) ||
                (h >= 65 && h <= 70) ||
                (h >= 97 && h <= 102) ||
                h === 95
              ) {
                i++;
              } else break;
            }

            tokens.push(TOK_N);
            continue;
          }
        }
      }

      i++;

      while (i < n) {
        const d = source.charCodeAt(i);

        if ((d >= 48 && d <= 57) || d === 95 || d === 46) i++;
        else break;
      }

      if (i < n) {
        const e = source.charCodeAt(i);

        if (e === 101 || e === 69) {
          let k = i + 1;

          if (k < n) {
            const sign = source.charCodeAt(k);

            if (sign === 43 || sign === 45) k++;
          }

          if (k < n) {
            const d = source.charCodeAt(k);

            if (d >= 48 && d <= 57) {
              k++;

              while (k < n && source.charCodeAt(k) >= 48 && source.charCodeAt(k) <= 57) k++;
              i = k;
            }
          }
        }
      }

      if (i < n) {
        const s = source.charCodeAt(i);

        if (
          s === 102 ||
          s === 70 ||
          s === 100 ||
          s === 68 ||
          s === 108 ||
          s === 76 ||
          s === 117 ||
          s === 85
        ) {
          i++;
        }
      }

      tokens.push(TOK_N);
      continue;
    }

    // "(?:[^"\\]|\\.)*" | '(?:[^'\\]|\\.)*' | `(?:[^`\\]|\\.)*`
    // `.` does not match U+000A / U+000D / U+2028 / U+2029, so `\\` + those fails the alt.
    if (c === 34 || c === 39 || c === 96) {
      let j = i + 1;
      let closed = false;

      while (j < n) {
        const d = source.charCodeAt(j);

        if (d === c) {
          closed = true;
          j++;
          break;
        }

        if (d === 92) {
          const next = j + 1 < n ? source.charCodeAt(j + 1) : -1;

          if (next < 0 || next === 10 || next === 13 || next === 0x2028 || next === 0x2029) break;
          j += 2;
          continue;
        }

        j++;
      }

      if (closed) {
        tokens.push(TOK_S);
        i = j;
        continue;
      }
      // Failed string alt: `[^\s\w]` takes the opener, and quote-start tokens map to $S.
      tokens.push(TOK_S);
      i++;
      continue;
    }

    // [^\s\w]
    tokens.push(source[i] as string);
    i++;
  }
  return tokens;
}

const NUM_HASHES = 128;
const SHINGLE_K = 3;

// Odd a,b so h_i(x) = a_i*x + b_i is a bijection mod 2^32. Fixed seed, not RNG.
const HASH_A = new Uint32Array(NUM_HASHES);

const HASH_B = new Uint32Array(NUM_HASHES);

{
  let seed = 0xa5f2c91d;

  const next = (): number => {
    seed = (seed + 0x9e3779b9) >>> 0;
    let z = seed;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);

    return (z ^ (z >>> 16)) >>> 0;
  };

  for (let i = 0; i < NUM_HASHES; i++) {
    HASH_A[i] = next() | 1;
    HASH_B[i] = next() | 1;
  }
}

// tokenize() collapses identifiers/strings/numbers to $I/$S/$N and keeps KEYWORDS.
// Precompute xxHash32 once so hashTokensU32 does not rehash those repeats.
const TOKEN_XXHASH32 = new Map<string, number>();

{
  const intern = (t: string): void => {
    TOKEN_XXHASH32.set(t, Bun.hash.xxHash32(t) >>> 0);
  };

  intern(TOK_I);
  intern(TOK_S);
  intern(TOK_N);

  for (const kw of KEYWORDS) intern(kw);
}

/** Test-visible interned xxHash32 of tokenize() volume tokens. */
export function hashTokensU32(tokens: string[]): Uint32Array {
  const n = tokens.length;
  const out = new Uint32Array(n);
  const intern = TOKEN_XXHASH32;

  for (let i = 0; i < n; i++) {
    const t = tokens[i] as string;
    const hit = intern.get(t);
    out[i] = hit !== undefined ? hit : Bun.hash.xxHash32(t) >>> 0;
  }

  return out;
}

function mix3(a: number, b: number, c: number): number {
  let h = a;
  h = Math.imul(h, 0x9e3779b1) ^ b;
  h = Math.imul(h, 0x9e3779b1) ^ c;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);

  return (h ^ (h >>> 16)) >>> 0;
}

export function computeMinHash(tokens: string[]): Uint32Array | null {
  if (tokens.length < SHINGLE_K + 2) return null;

  const sig = new Uint32Array(NUM_HASHES);
  sig.fill(0xffffffff);

  const th = hashTokensU32(tokens);
  const shingleCount = tokens.length - SHINGLE_K + 1;
  for (let s = 0; s < shingleCount; s++) {
    const x = mix3(th[s] as number, th[s + 1] as number, th[s + 2] as number);

    for (let i = 0; i < NUM_HASHES; i++) {
      const v = (Math.imul(HASH_A[i] as number, x) + (HASH_B[i] as number)) >>> 0;

      if (v < (sig[i] as number)) sig[i] = v;
    }
  }

  return sig;
}

export function jaccardSimilarity(a: Uint32Array, b: Uint32Array): number {
  let matches = 0;
  for (let i = 0; i < NUM_HASHES; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / NUM_HASHES;
}

/**
 * Version of the token/MinHash/fragment scheme in this file. Persisted in the
 * repo-map `meta` table — when it changes, stored token_signatures and
 * token_fragments rows are silently incomparable with fresh rows and must be
 * regenerated. Bump whenever tokenize/computeMinHash/computeFragmentHashes
 * change their output.
 */
export const CLONE_HASH_SCHEME_VERSION = 1;

const FRAGMENT_WINDOW = 12;
const MIN_FRAGMENT_TOKENS = FRAGMENT_WINDOW + 4;

interface FragmentHash {
  hash: string;
  tokenOffset: number;
}

export function computeFragmentHashes(tokens: string[]): FragmentHash[] {
  if (tokens.length < MIN_FRAGMENT_TOKENS) return [];

  const th = hashTokensU32(tokens);
  const results: FragmentHash[] = [];
  const windowCount = tokens.length - FRAGMENT_WINDOW + 1;
  for (let i = 0; i < windowCount; i++) {
    let h = 0;

    for (let j = 0; j < FRAGMENT_WINDOW; j++) {
      h = Math.imul(h, 0x9e3779b1) ^ (th[i + j] as number);
    }

    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    results.push({ hash: ((h ^ (h >>> 16)) >>> 0).toString(16), tokenOffset: i });
  }

  return results;
}
