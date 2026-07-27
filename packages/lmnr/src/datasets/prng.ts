// Cross-language parity surface: `seededPerm` is mirrored byte-for-byte by the
// Python SDK's `seeded_perm`. The permutation is a PURE function of (n, seed) —
// the same (n, seed) MUST yield the same permutation in both SDKs so a seeded
// `dataset.shuffle({ seed })` reproduces across languages. Do NOT swap in an
// off-the-shelf RNG: no library is byte-identical across JS and Python. Any
// change here must be mirrored in the Python SDK and the shared vector fixture
// `test/data/dataset/seeded_perm_cases.json`.
//
// Algorithm: mulberry32 (a tiny deterministic 32-bit generator) driving a
// downward Fisher–Yates shuffle. Python emulates the uint32 wraparound and the
// 32-bit multiply (`Math.imul`) explicitly to match.

const UINT32 = 0x100000000; // 2^32

/**
 * Deterministic permutation of `[0, n)` seeded by `seed`.
 *
 * @param n - Number of indices to permute.
 * @param seed - Integer seed; reduced mod 2^32.
 * @returns A permutation of `[0, 1, ..., n-1]`.
 */
export const seededPerm = (n: number, seed: number): number[] => {
  let state = seed >>> 0; // seed mod 2^32

  // mulberry32 -> float in [0, 1)
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };

  const ix = Array.from({ length: n }, (_, i) => i);
  // Fisher–Yates, downward.
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [ix[i], ix[j]] = [ix[j], ix[i]];
  }
  return ix;
};
