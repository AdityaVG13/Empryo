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

const TOKEN_RE =
  /[a-zA-Z_$]\w*|0[xXbBoO][\da-fA-F_]+|\d[\d_.]*(?:[eE][+-]?\d+)?[fFdDlLuU]?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^\s\w]/g;

function normalizeToken(token: string): string {
  if (token.length === 0) return token;
  const first = token[0] as string;
  if (first === '"' || first === "'" || first === "`") return "$S";
  if (/^\d/.test(token) || /^0[xXbBoO]/.test(token)) return "$N";
  if (/^[a-zA-Z_$]/.test(token)) {
    return KEYWORDS.has(token) ? token : "$I";
  }
  return token;
}

export function tokenize(source: string): string[] {
  const tokens: string[] = [];
  for (const match of source.matchAll(TOKEN_RE)) {
    tokens.push(normalizeToken(match[0]));
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

function hashTokensU32(tokens: string[]): Uint32Array {
  const n = tokens.length;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Bun.hash.xxHash32(tokens[i] as string) >>> 0;
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
