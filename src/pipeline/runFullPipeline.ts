// Convenience entrypoint for Stage 2 (extraction). This is what Stage 6's
// Zoom webhook handler will eventually call after writing a transcript.
//
// Changed 2026-07-16: no longer chains straight into Stage 3 notifications.
// Takeaways/action items/follow-ups are now suggest-then-approve (see
// db/schema.ts's meeting_insights comment), so notifications only fire once
// Peter has actually reviewed a meeting's suggestions — see
// src/pipeline/reviewMeeting.ts, which is what now triggers sendNotifications.
// The name "runFullPipeline" predates this change and is a bit of a misnomer
// now (it's really just Stage 2), but callers (app.ts, cli.ts) already
// reference it by this name — not worth a rename churn for this change alone.

import { processMeeting, type ProcessMeetingOptions, type ProcessMeetingResult } from "./processMeeting";

export interface RunFullPipelineResult {
  processed: ProcessMeetingResult;
}

export async function runFullPipeline(
  meetingId: string,
  options: ProcessMeetingOptions = {}
): Promise<RunFullPipelineResult> {
  const processed = await processMeeting(meetingId, options);
  return { processed };
}
