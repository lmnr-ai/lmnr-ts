import nacl from "tweetnacl";

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

// NaCl box (X25519 + XSalsa20-Poly1305) keypair. Public goes to the
// frontend in the cli-login URL; secret stays in this process and is
// used to open the box returned via the grants endpoint.
export const generateKeyPair = (): KeyPair => nacl.box.keyPair();

export const b64url = {
  encode: (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString("base64url"),
  decode: (s: string): Uint8Array =>
    new Uint8Array(Buffer.from(s, "base64url")),
};

// Returns null on tampering / wrong key. Caller treats null as a hard
// failure (do NOT retry — somebody fed a malformed payload).
export const decryptBox = (
  cipher: Uint8Array,
  nonce: Uint8Array,
  theirPublic: Uint8Array,
  mySecret: Uint8Array,
): Uint8Array | null => nacl.box.open(cipher, nonce, theirPublic, mySecret);
