// Local pickup endpoints for Zoom transcripts staged by the webhook handler
// (src/ingest/captureFromZoomWebhook.ts) into zoom_pending_exports. Consumed
// by src/ingest/scanFolder.ts's `pull-zoom` subcommand, which writes each
// pending row into TRANSCRIPT_WATCH_DIR as a .txt and then deletes it here
// only once that write has actually succeeded — a two-step fetch-then-confirm
// (not fetch-and-delete-in-one-call), so a crash between the two can't
// silently lose a transcript; the next pull just sees it again.
//
// Single-account for now (Peter's own Zoom account only, via the dedicated
// export app in src/integrations/zoom.ts) — not scoped by user yet.
// Registered inside app.ts's requireAuth-hooked scope, same worker-key auth
// as every other local-script-facing route.

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/client";

export function registerZoomExportRoutes(app: FastifyInstance): void {
  app.get("/api/zoom/pending-exports", async (_req, reply) => {
    const rows = await db
      .select({
        id: schema.zoomPendingExports.id,
        zoomMeetingId: schema.zoomPendingExports.zoomMeetingId,
        topic: schema.zoomPendingExports.topic,
        startTime: schema.zoomPendingExports.startTime,
        durationMinutes: schema.zoomPendingExports.durationMinutes,
        hostEmail: schema.zoomPendingExports.hostEmail,
        transcriptText: schema.zoomPendingExports.transcriptText,
      })
      .from(schema.zoomPendingExports)
      .orderBy(schema.zoomPendingExports.createdAt);
    return reply.send({
      pendingExports: rows.map((r) => ({ ...r, startTime: r.startTime.toISOString() })),
    });
  });

  app.delete<{ Params: { id: string } }>("/api/zoom/pending-exports/:id", async (req, reply) => {
    const [found] = await db
      .delete(schema.zoomPendingExports)
      .where(eq(schema.zoomPendingExports.id, req.params.id))
      .returning({ id: schema.zoomPendingExports.id });
    if (!found) {
      return reply.code(404).send({ error: `No pending Zoom export found for id ${req.params.id}` });
    }
    return reply.code(204).send();
  });
}
