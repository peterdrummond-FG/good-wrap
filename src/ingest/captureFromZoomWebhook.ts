// Orchestrates one Zoom "recording.transcript_completed" webhook delivery
// into a captured + processed meeting. Called from app.ts's
// POST /api/webhooks/zoom AFTER it has already replied 200 to Zoom — this
// runs detached from the request/reply lifecycle (see app.ts's comment on
// why), so every error here is only ever logged by the caller, never thrown
// back into Fastify.

import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import {
  getZoomAccessToken,
  downloadRecordingFile,
  parseVttToPlainText,
  type ZoomWebhookEnvelope,
} from "../integrations/zoom";
import { captureManualMeeting } from "./captureManualMeeting";
import { runFullPipeline } from "../pipeline/runFullPipeline";

export async function handleZoomTranscriptEvent(payload: ZoomWebhookEnvelope): Promise<void> {
  const object = payload.payload?.object;
  const zoomMeetingId = object?.uuid;
  if (!object || !zoomMeetingId) {
    throw new Error("Zoom webhook payload is missing payload.object.uuid.");
  }

  // Explicit dedup check before capturing — the primary path (not just the
  // partial unique index on meetings.zoom_meeting_id, which is the
  // last-resort safety net for a genuine race between two concurrent
  // retries). Zoom is known to redeliver webhooks, and re-capturing would
  // otherwise create a second meeting for the same recording.
  const [existing] = await db
    .select({ id: schema.meetings.id })
    .from(schema.meetings)
    .where(eq(schema.meetings.zoomMeetingId, zoomMeetingId))
    .limit(1);
  if (existing) {
    console.log(`Zoom webhook: meeting ${zoomMeetingId} already captured (id ${existing.id}) — skipping duplicate delivery.`);
    return;
  }

  const transcriptFile = (object.recording_files ?? []).find((f) => f.file_type === "TRANSCRIPT");
  if (!transcriptFile) {
    throw new Error(`Zoom webhook: no TRANSCRIPT file in recording_files for meeting ${zoomMeetingId}.`);
  }

  const accessToken = await getZoomAccessToken();
  const vtt = await downloadRecordingFile(transcriptFile.download_url, accessToken);
  const transcript = parseVttToPlainText(vtt);

  // Zoom's recording payload only reliably gives the host's email, not a
  // full attendee list (that needs a separate paid-plan report API) — Peter
  // fixes up the participant list afterward via the existing meeting-edit UI.
  const result = await captureManualMeeting({
    topic: object.topic?.trim() || "Zoom meeting",
    startTime: object.start_time ?? new Date().toISOString(),
    durationMinutes: object.duration,
    participants: object.host_email ? [{ email: object.host_email }] : [],
    transcript,
    source: "zoom",
    zoomMeetingId,
  });

  console.log(`Zoom webhook: captured meeting ${result.meetingId} from Zoom recording ${zoomMeetingId}.`);
  await runFullPipeline(result.meetingId);
}
