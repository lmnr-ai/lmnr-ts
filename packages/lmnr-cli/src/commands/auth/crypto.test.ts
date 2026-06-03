import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { b64url, decryptBox, generateKeyPair } from "./crypto";

describe("b64url", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    const encoded = b64url.encode(bytes);
    const decoded = b64url.decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("does not include = padding", () => {
    const encoded = b64url.encode(new Uint8Array([1, 2, 3]));
    expect(encoded).not.toContain("=");
  });
});

describe("generateKeyPair + decryptBox", () => {
  it("decrypts a payload encrypted with the matching public key", () => {
    const recipient = generateKeyPair();
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(24);

    const message = "hello world";
    const encrypted = nacl.box(
      new TextEncoder().encode(message),
      nonce,
      recipient.publicKey,
      ephemeral.secretKey,
    );

    const decrypted = decryptBox(
      encrypted,
      nonce,
      ephemeral.publicKey,
      recipient.secretKey,
    );
    expect(decrypted).not.toBeNull();
    expect(Buffer.from(decrypted!).toString("utf-8")).toBe(message);
  });

  it("returns null when the secret key is wrong", () => {
    const recipient = generateKeyPair();
    const attacker = generateKeyPair();
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(24);

    const encrypted = nacl.box(
      new TextEncoder().encode("secret"),
      nonce,
      recipient.publicKey,
      ephemeral.secretKey,
    );

    const decrypted = decryptBox(
      encrypted,
      nonce,
      ephemeral.publicKey,
      attacker.secretKey,
    );
    expect(decrypted).toBeNull();
  });

  it("generates a 32-byte public key", () => {
    const { publicKey } = generateKeyPair();
    expect(publicKey.length).toBe(32);
  });
});
