// Admin-only routes: the whole "invite a teammate" mechanism (decision:
// small known team, invited by an admin — not open self-serve signup), plus
// offboarding (revoking anyone's worker key, disabling a departed user).
//
// Registered inside a scope that already applies both requireAuth AND
// requireAdmin as preHandlers (see app.ts) — every route here can assume
// req.currentUser is set and is an admin.

import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db/client";

export function registerAdminRoutes(app: FastifyInstance): void {
  // The entire invite mechanism: pre-create a `users` row with just a name +
  // email. That person's first Google/Microsoft SSO login auto-links to this
  // row by email match (see src/server/auth.ts's resolveInvitedUser) — no
  // invite email to send, no separate allow-list to maintain.
  app.post<{ Body: { name?: string; email?: string; role?: "admin" | "member" } }>(
    "/api/admin/users",
    async (req, reply) => {
      const name = req.body?.name?.trim();
      const email = req.body?.email?.trim().toLowerCase();
      if (!name || !email) {
        return reply.code(400).send({ error: "name and email are both required." });
      }
      const role = req.body?.role === "admin" ? "admin" : "member";

      const [row] = await db
        .insert(schema.users)
        .values({ name, email, role })
        .onConflictDoNothing({ target: schema.users.email })
        .returning({ id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.users.role });

      if (!row) {
        return reply.code(409).send({ error: `A user with email ${email} already exists.` });
      }
      return reply.code(201).send({ user: row });
    }
  );

  app.get("/api/admin/users", async (_req, reply) => {
    const rows = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.users.role,
        disabledAt: schema.users.disabledAt,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt));
    return reply.send({ users: rows });
  });

  // Immediately kills a departed teammate's dashboard session and API access
  // (checked by requireAuth) without deleting their historical meeting data.
  app.post<{ Params: { id: string }; Body: { disabled?: boolean } }>(
    "/api/admin/users/:id/disabled",
    async (req, reply) => {
      const disabled = Boolean(req.body?.disabled);
      const [found] = await db
        .update(schema.users)
        .set({ disabledAt: disabled ? new Date() : null })
        .where(eq(schema.users.id, req.params.id))
        .returning({ id: schema.users.id });
      if (!found) {
        return reply.code(404).send({ error: `No user found for id ${req.params.id}` });
      }
      return reply.send({ ok: true });
    }
  );

  // Offboarding: view or revoke ANY user's worker keys (self-service revoke
  // for your own keys lives at /api/worker-keys instead).
  app.get<{ Params: { id: string } }>("/api/admin/users/:id/worker-keys", async (req, reply) => {
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
      .where(eq(schema.workerApiKeys.userId, req.params.id))
      .orderBy(desc(schema.workerApiKeys.createdAt));
    return reply.send({ workerKeys: rows });
  });

  app.delete<{ Params: { keyId: string } }>("/api/admin/worker-keys/:keyId", async (req, reply) => {
    const [found] = await db
      .update(schema.workerApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.workerApiKeys.id, req.params.keyId))
      .returning({ id: schema.workerApiKeys.id });
    if (!found) {
      return reply.code(404).send({ error: `No worker key found for id ${req.params.keyId}` });
    }
    return reply.code(204).send();
  });
}
