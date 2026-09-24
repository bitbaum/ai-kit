/**
 * Sealing a reader's API key for storage at rest — server only.
 *
 * An app that remembers a signed-in reader's key must store it where the
 * database alone cannot read it. OrangeCat did this first (AES-256-GCM, a
 * scrypt-derived key, `iv:tag:ciphertext` in hex); this is that scheme, moved
 * here so the second app does not write a second one with a different format.
 *
 * `secret` is the app's own env value (`openssl rand -base64 32`). `context`
 * separates what one secret seals for different purposes: a value sealed as
 * "byok" does not open as anything else. GCM authenticates, so a tampered or
 * wrongly-keyed value throws rather than decrypting to garbage.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function keyFor(secret: string, context: string): Buffer {
  if (!secret || secret.length < 16)
    throw new Error("A sealing secret of 16+ characters is required.");
  return scryptSync(secret, `ai-kit-seal:${context}`, 32);
}

/** `iv:tag:ciphertext`, hex. */
export function sealSecret(plain: string, secret: string, context = "byok"): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(secret, context), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${body.toString("hex")}`;
}

/** Throws on a malformed, tampered or wrongly-keyed value. */
export function openSecret(sealed: string, secret: string, context = "byok"): string {
  const [iv, tag, body] = sealed.split(":");
  if (!iv || !tag || !body) throw new Error("Not a sealed value.");
  const decipher = createDecipheriv(ALGORITHM, keyFor(secret, context), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(body, "hex")), decipher.final()]).toString(
    "utf8",
  );
}
