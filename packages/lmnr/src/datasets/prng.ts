// Mirrors the Python SDK's `seeded_perm` byte-for-byte. Do NOT swap in an
// off-the-shelf RNG: no library is byte-identical across JS and Python.

const UINT32 = 0x100000000; // 2^32

// Deterministic permutation of `[0, n)`. `seed` is an integer, reduced mod 2^32.
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
