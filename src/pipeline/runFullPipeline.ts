// Convenience entrypoint chaining Stage 2 -> Stage 3, matching the brief:
// "Once Stage 2 completes, fire [notifications]." This is what Stage 6's
// Zoom webhook handler will eventually call after writing a transcript.

import { processMeeting, type ProcessMeetingOptions, type ProcessMeetingResult } from "./processMeeting";
import { sendNotifications, type SendNotificationsResult } from "../notify/sendNotifications";

export interface RunFullPipelineResult {
  processed: ProcessMeetingResult;
  notified: SendNotificationsResult;
}

export async function runFullPipeline(
  meetingId: string,
  options: ProcessMeetingOptions = {}
): Promise<RunFullPipelineResult> {
  const processed = await processMeeting(meetingId, options);
  const notified = await sendNotifications(meetingId);
  return { processed, notified };
}
