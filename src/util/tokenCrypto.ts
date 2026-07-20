// Encrypts OAuth access/refresh tokens before they ever reach
// user_integrations (see db/schema.ts) — application-layer AES-256-GCM,
// keyed by a single INTEGRATION_TOKEN_ENCRYPTION_KEY env var (32 bytes,
// base64 — generate once via `openssl rand -base64 32`, Railway-only, never
// committed). This matches the trust model already used elsewhere in this
// project for other shared secrets (LOCAL_WORKER_API_KEY,
// ZOOM_WEBHOOK_SECRET_TOKEN) — appropriate for a small internal team; a
// KMS/Vault would add real operational overhead without meaningfully
// raising the actual trust boundary here (this DB connection is already
// full-trust, no RLS-enforced access model).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEnv } from "./env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function loadKey(): Buffer {
  const key = Buffer.from(requireEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) {
    throw new Error(
      `INTEGRATION_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}) — generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

/** Encrypts a plaintext token. Output format: `<iv>:<authTag>:<ciphertext>`,
 * each base64 — safe to store directly in a `text` column. */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Inverse of encryptToken. Throws if the ciphertext was tampered with or
 * encrypted under a different key (GCM's authTag check fails). */
export function decryptToken(stored: string): string {
  const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted token — expected '<iv>:<authTag>:<ciphertext>'.");
  }
  const decipher = createDecipheriv(ALGORITHM, loadKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf-8");
}
