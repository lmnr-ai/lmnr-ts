import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// PKCE (RFC 7636) + loopback `state`, all via node:crypto.

// 32 random bytes → 43-char base64url, well within RFC's 43–128 range.
export const generateVerifier = (): string => randomBytes(32).toString("base64url");

export const deriveChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

export const generateState = (): string => randomBytes(32).toString("base64url");

// Constant-time compare with a length guard (timingSafeEqual throws on
// unequal-length buffers). Used to validate the `state` echoed back to the
// loopback server.
export const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};
