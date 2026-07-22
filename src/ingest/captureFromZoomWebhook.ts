// Handles one Zoom "recording.transcript_completed" webhook delivery by
// downloading + converting the transcript and staging it for local pickup
// in zoom_pending_exports.
//
// This used to call captureManualMeeting + runFullPipeline directly here,
// billing every meeting to ANTHROPIC_API_KEY and bypassing the watch folder
// entirely. Reworked so Zoom-sourced meetings flow through the same free,
// local-Claude-Code watch-folder pipeline as every other capture path:
// src/ingest/scanFolder.ts's `pull-zoom` subcommand (run every 20 min
// alongside the rest of the folder scan) fetches pending rows here, writes
// each as a .txt into TRANSCRIPT_WATCH_DIR, and the existing
// process-transcripts skill takes it from there — see
// POST /api/meetings/upload-processed for where zoomMeetingId eventually
// lands on the real meetings row.
//
// Called from app.ts's POST /api/webhooks/zoom AFTER it has already replied
// 200 to Zoom — this runs detached from the request/reply lifecycle (see
// app.ts's comment on why), so every error here is only ever logged by the
// caller, never thrown back into Fastify.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import {
  getZoomAccessToken,
  downloadRecordingFile,
  parseVttToPlainText,
  listPastMeetingParticipants,
  type ZoomWebhookEnvelope,
} from "../integrations/zoom";

export async function handleZoomTranscriptEvent(payload: ZoomWebhookEnvelope): Promise<void> {
  const object = payload.payload?.object;
  const zoomMeetingId = object?.uuid;
  if (!object || !zoomMeetingId) {
    throw new Error("Zoom webhook payload is missing payload.object.uuid.");
  }

  // Skip early if this recording has already been fully captured (e.g. a
  // very late webhook redelivery, long after the pending export was pulled,
  // processed, and uploaded) — avoids a wasted download and a duplicate
  // pending row for something that's already done.
  const [existingMeeting] = await db
    .select({ id: schema.meetings.id })
    .from(schema.meetings)
    .where(eq(schema.meetings.zoomMeetingId, zoomMeetingId))
    .limit(1);
  if (existingMeeting) {
    console.log(`Zoom webhook: meeting ${zoomMeetingId} already captured (id ${existingMeeting.id}) — skipping.`);
    return;
  }

  const transcriptFile = (object.recording_files ?? []).find((f) => f.file_type === "TRANSCRIPT");
  if (!transcriptFile) {
    throw new Error(`Zoom webhook: no TRANSCRIPT file in recording_files for meeting ${zoomMeetingId}.`);
  }

  const accessToken = await getZoomAccessToken();
  const vtt = await downloadRecordingFile(transcriptFile.download_url, accessToken);
  const transcript = parseVttToPlainText(vtt);

  // Best-effort — a failure here (scope issue, meeting not found, transient
  // error) must never block capturing the transcript itself. Falls back to
  // host-only (via hostEmail below) when this comes back empty/fails.
  let participants: { name: string; email?: string }[] = [];
  try {
    const zoomParticipants = await listPastMeetingParticipants(accessToken, zoomMeetingId);
    participants = zoomParticipants.map((p) => ({ name: p.name, email: p.user_email || undefined }));
  } catch (err) {
    console.error(`Zoom webhook: couldn't fetch participants for meeting ${zoomMeetingId}:`, (err as Error).message);
  }

  // onConflictDoNothing (unique on zoomMeetingId) absorbs Zoom's own known
  // near-term webhook-retry behavior — a redelivered event just no-ops here
  // instead of staging a duplicate row.
  const [inserted] = await db
    .insert(schema.zoomPendingExports)
    .values({
      zoomMeetingId,
      topic: object.topic?.trim() || "Zoom meeting",
      startTime: object.start_time ? new Date(object.start_time) : new Date(),
      durationMinutes: object.duration,
      hostEmail: object.host_email,
      participants: participants.length > 0 ? participants : undefined,
      transcriptText: transcript,
    })
    .onConflictDoNothing({ target: schema.zoomPendingExports.zoomMeetingId })
    .returning({ id: schema.zoomPendingExports.id });

  console.log(
    inserted
      ? `Zoom webhook: staged recording ${zoomMeetingId} as pending export ${inserted.id}.`
      : `Zoom webhook: recording ${zoomMeetingId} already staged — skipping duplicate delivery.`
  );
}
