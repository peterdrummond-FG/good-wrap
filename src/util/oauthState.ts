// Stateless, signed OAuth `state` param — carries everything the callback
// route needs (which user/provider started this, and the PKCE verifier) as
// an HMAC-signed, base64url blob instead of a server-side session/table.
// Survives a Railway restart mid-flow and needs no cleanup job. See
// src/server/routes/integrations.ts for where this is used.

import { createHmac, timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { requireEnv } from "./env";

export interface OAuthStateData {
  userId: string;
  provider: "zoom" | "asana";
  pkceVerifier: string;
  /** Epoch ms — state older than this is rejected even with a valid signature. */
  exp: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", requireEnv("OAUTH_STATE_SECRET")).update(payload).digest("base64url");
}

export function signState(data: Omit<OAuthStateData, "exp">): string {
  const full: OAuthStateData = { ...data, exp: Date.now() + STATE_TTL_MS };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Returns null if the state is malformed, incorrectly signed, or expired —
 * callers treat any of these as "invalid OAuth callback", not a crash. */
export function verifyState(state: string | undefined): OAuthStateData | null {
  if (!state) return null;
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null;

  let data: OAuthStateData;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
  return data;
}

// --- PKCE (RFC 7636) ---------------------------------------------------------------
// Both Zoom's and Asana's per-user OAuth apps support PKCE — used on top of
// (not instead of) the signed state above, per the "real per-user OAuth"
// decision's spirit of doing this properly rather than the minimum.

export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function derivePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
