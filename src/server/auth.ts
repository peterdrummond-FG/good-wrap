// Authentication for good-wrap's dashboard users (Supabase Auth SSO) and for
// the local watch-folder worker script (per-user API keys) — see
// db/schema.ts's users/user_integrations/worker_api_keys tables.
//
// Two ways a request can authenticate, both resolving the same
// `req.currentUser`:
//   1. `Authorization: Bearer <Supabase session JWT>` — verified against
//      Supabase's JWKS (asymmetric keys, not a static HS256 secret — this is
//      the future-proof choice since Supabase is moving projects off
//      symmetric signing). First-login auto-link: a `users` row an admin
//      pre-created (email only, supabase_user_id null) gets linked to the
//      verified token's `sub` the first time that email ever logs in. A
//      verified token whose email matches no `users` row at all is rejected
//      (403) — this is the entire "invited, not self-serve" gate; there's no
//      separate allow-list to maintain.
//   2. `x-worker-key: <raw key>` — how the local process-transcripts skill
//      authenticates; hashed and looked up in worker_api_keys.
//
// REQUIRE_AUTH (env var, default "false") is a rollout kill switch: while
// false, a request with no valid credentials at all still resolves
// `req.currentUser` via the legacy DEFAULT_OWNER_EMAIL single-user
// assumption instead of being rejected — this is what lets the backend ship
// with all this new code before the frontend/local scripts are actually
// sending real credentials yet, without a synchronized flag day across
// Railway and Vercel. A verified-but-uninvited SSO login is still rejected
// (403) regardless of this flag — that gate isn't part of the rollout.

import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { requireEnv } from "../util/env";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: CurrentUser;
  }
}

function requireAuthEnabled(): boolean {
  return (process.env.REQUIRE_AUTH ?? "false").toLowerCase() === "true";
}

// Lazily created (not at import time) so the process doesn't crash on
// startup just because SUPABASE_URL isn't set yet in an environment that
// hasn't been migrated onto this auth system (e.g. REQUIRE_AUTH=false with
// no frontend sending bearer tokens at all yet). jose's createRemoteJWKSet
// caches the fetched key set internally — no extra caching needed here.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    jwks = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

type UserRow = typeof schema.users.$inferSelect;

function toCurrentUser(row: UserRow): CurrentUser {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

async function loadUserBySupabaseId(supabaseUserId: string): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.supabaseUserId, supabaseUserId))
    .limit(1);
  return row ?? null;
}

async function loadUserByEmail(email: string): Promise<UserRow | null> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return row ?? null;
}

interface VerifiedIdentity {
  supabaseUserId: string;
  email: string | null;
}

/** Verifies the bearer token's signature/expiry against Supabase's JWKS.
 * Returns null if the header is missing or the token doesn't check out —
 * callers treat that as "not authenticated this way", not "rejected". */
async function verifyBearerToken(authHeader: string | undefined): Promise<VerifiedIdentity | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);

  try {
    const { payload } = await jwtVerify(token, getJwks());
    if (typeof payload.sub !== "string") return null;
    return { supabaseUserId: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
  } catch {
    return null;
  }
}

/** Resolves a verified Supabase identity to an invited `users` row,
 * auto-linking on first login (see file header). Returns null if no
 * `users` row was ever pre-created for this email — the invite-only gate. */
async function resolveInvitedUser(identity: VerifiedIdentity): Promise<CurrentUser | null> {
  let userRow = await loadUserBySupabaseId(identity.supabaseUserId);

  if (!userRow && identity.email) {
    const byEmail = await loadUserByEmail(identity.email);
    // Only auto-link a row that's genuinely unclaimed — if it's already
    // linked to a *different* supabase_user_id (shouldn't happen in
    // practice), don't silently take it over.
    if (byEmail && byEmail.supabaseUserId === null) {
      const [updated] = await db
        .update(schema.users)
        .set({ supabaseUserId: identity.supabaseUserId })
        .where(eq(schema.users.id, byEmail.id))
        .returning();
      userRow = updated;
    }
  }

  if (!userRow || userRow.disabledAt) return null;
  return toCurrentUser(userRow);
}

/** The pre-auth single-user assumption this whole system used to run on —
 * kept only as a rollout fallback (see file header and resolveFromWorkerKey
 * below). */
async function resolveLegacyOwner(): Promise<CurrentUser | null> {
  const email = process.env.DEFAULT_OWNER_EMAIL;
  if (!email) return null;
  const row = await loadUserByEmail(email);
  return row ? toCurrentUser(row) : null;
}

/** Hashes the provided worker key and resolves the user it belongs to, if
 * any non-revoked key matches. Updates last_used_at fire-and-forget. Falls
 * back to the legacy global LOCAL_WORKER_API_KEY shared secret (resolving to
 * DEFAULT_OWNER_EMAIL, exactly today's behavior) so Peter's already-running
 * launchd job keeps working unmodified until he (and everyone else) has
 * migrated to a personal key — remove this branch once that's confirmed
 * complete for every active user (see .env.example). */
async function resolveFromWorkerKey(rawKey: string | undefined): Promise<CurrentUser | null> {
  if (!rawKey) return null;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const [row] = await db
    .select({ keyId: schema.workerApiKeys.id, revokedAt: schema.workerApiKeys.revokedAt, user: schema.users })
    .from(schema.workerApiKeys)
    .innerJoin(schema.users, eq(schema.users.id, schema.workerApiKeys.userId))
    .where(eq(schema.workerApiKeys.keyHash, keyHash))
    .limit(1);

  if (row && !row.revokedAt && !row.user.disabledAt) {
    void db
      .update(schema.workerApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.workerApiKeys.id, row.keyId))
      .catch(() => {
        // Best-effort only — a failed last-used-at bump shouldn't fail the
        // request that's using the key right now.
      });
    return toCurrentUser(row.user);
  }

  const legacyKey = process.env.LOCAL_WORKER_API_KEY;
  if (legacyKey && rawKey === legacyKey) {
    return resolveLegacyOwner();
  }
  return null;
}

/** Fastify preHandler — resolves `req.currentUser` or replies with an error.
 * Register on any route group that needs a real signed-in user (see
 * src/server/routes/*.ts). Not used on the Zoom webhook or
 * upload-processed/me/people/companies routes, which accept a worker key
 * directly inline instead (see routes/public.ts). */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const workerKeyHeader = req.headers["x-worker-key"];
  if (typeof workerKeyHeader === "string") {
    const viaWorkerKey = await resolveFromWorkerKey(workerKeyHeader);
    if (viaWorkerKey) {
      req.currentUser = viaWorkerKey;
      return;
    }
    if (requireAuthEnabled()) {
      reply.code(401).send({ error: "Invalid or revoked x-worker-key." });
      return;
    }
    // REQUIRE_AUTH is off and this worker key didn't match anything real —
    // fall through to the bearer/legacy paths below rather than rejecting.
  }

  const identity = await verifyBearerToken(req.headers.authorization);
  if (identity) {
    const invited = await resolveInvitedUser(identity);
    if (invited) {
      req.currentUser = invited;
      return;
    }
    // A genuinely valid SSO login that isn't on the invite list is always
    // rejected — this gate doesn't relax during rollout.
    reply.code(403).send({ error: "Not invited — ask an admin to add you first." });
    return;
  }

  if (!requireAuthEnabled()) {
    const legacy = await resolveLegacyOwner();
    if (legacy) {
      req.currentUser = legacy;
      return;
    }
  }

  reply.code(401).send({ error: "Missing or invalid credentials." });
}

/** An admin-role check — assumes it's registered on a scope nested inside
 * one that already applies requireAuth as a preHandler (see app.ts), so
 * req.currentUser is already resolved by the time this runs. Deliberately
 * does not call requireAuth itself, to avoid a redundant second credential
 * lookup on every admin route. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.currentUser) {
    reply.code(401).send({ error: "Missing or invalid credentials." });
    return;
  }
  if (req.currentUser.role !== "admin") {
    reply.code(403).send({ error: "Admin access required." });
  }
}
