/** Parse the payload of a JWT without verifying the signature. */
export interface AccessTokenClaims {
  sub?: string;
  email?: string;
  project_id?: string;
  scope?: string;
  exp?: number;
  iat?: number;
  iss?: string;
}

export function decodeAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1];
    const buf = Buffer.from(payload, "base64url");
    return JSON.parse(buf.toString("utf-8")) as AccessTokenClaims;
  } catch {
    return null;
  }
}
