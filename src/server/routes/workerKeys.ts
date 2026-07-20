// Per-user worker API keys — how the local watch-folder pipeline
// (.claude/skills/process-transcripts/SKILL.md, via
// POST /api/meetings/upload-processed) authenticates as a specific person
// instead of the old single global LOCAL_WORKER_API_KEY shared secret. See
// db/schema.ts's worker_api_keys table and src/server/auth.ts's
// resolveFromWorkerKey, which is what actually verifies these on every
// request — this file only covers issuing/listing/revoking them.
//
// Registered inside app.ts's requireAuth-hooked scope, so every route here
// already has req.currentUser resolved.

import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/client";

const KEY_PREFIX = "gw_live_";

function generateRawKey(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** Shared by POST /api/worker-keys below and the Account page's "Generate
 * setup script" action (routes/integrations.ts), which issues its own key
 * behind the scenes rather than asking the user to create one first. */
export async function createWorkerKey(
  userId: string,
  label?: string | null
): Promise<{ id: string; keyPrefix: string; workerKey: string }> {
  const rawKey = generateRawKey();
  const [row] = await db
    .insert(schema.workerApiKeys)
    .values({
      userId,
      keyHash: hashKey(rawKey),
      keyPrefix: rawKey.slice(0, KEY_PREFIX.length + 6),
      label: label?.trim() || null,
    })
    .returning({ id: schema.workerApiKeys.id, keyPrefix: schema.workerApiKeys.keyPrefix });
  return { id: row.id, keyPrefix: row.keyPrefix, workerKey: rawKey };
}

export function registerWorkerKeyRoutes(app: FastifyInstance): void {
  // Lists the current user's own keys — never re-shows the raw value, only
  // the prefix (enough to recognize which key is which).
  app.get("/api/worker-keys", async (req, reply) => {
    const rows = await db
      .select({
        id: schema.workerApiKeys.id,
        keyPrefix: schema.workerApiKeys.keyPrefix,
        label: schema.workerApiKeys.label,
        createdAt: schema.workerApiKeys.createdAt,
        lastUsedAt: schema.workerApiKeys.lastUsedAt,
        revokedAt: schema.workerApiKeys.revokedAt,
      })
      .from(schema.workerApiKeys)
      .where(and(eq(schema.workerApiKeys.userId, req.currentUser!.id), isNull(schema.workerApiKeys.revokedAt)))
      .orderBy(desc(schema.workerApiKeys.createdAt));
    return reply.send({ workerKeys: rows });
  });

  // Issues a new key for the current user. The raw value is returned exactly
  // once here — only its hash is ever persisted (see db/schema.ts's comment).
  app.post<{ Body: { label?: string } }>("/api/worker-keys", async (req, reply) => {
    const created = await createWorkerKey(req.currentUser!.id, req.body?.label);
    return reply.code(201).send(created);
  });

  // Self-service revoke — only ever your own key (see the WHERE clause).
  app.delete<{ Params: { id: string } }>("/api/worker-keys/:id", async (req, reply) => {
    const [found] = await db
      .update(schema.workerApiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.workerApiKeys.id, req.params.id), eq(schema.workerApiKeys.userId, req.currentUser!.id)))
      .returning({ id: schema.workerApiKeys.id });
    if (!found) {
      return reply.code(404).send({ error: `No worker key found for id ${req.params.id}` });
    }
    return reply.code(204).send();
  });
}
