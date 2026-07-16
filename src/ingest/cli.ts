// Stage 0 CLI: run the manual capture from the command line instead of pasting
// into chat. Reads a JSON file describing one meeting and writes it to the DB
// via captureManualMeeting — the exact same function Stage 6's Zoom webhook
// will call later.
//
// Usage:
//   npm run capture -- path/to/meeting.json
//   cat meeting.json | npm run capture
//
// Expected JSON shape (see meeting.example.json in this folder):
// {
//   "topic": "Q3 Budget Review",
//   "startTime": "2026-07-14T15:00:00Z",
//   "durationMinutes": 45,
//   "participants": [
//     { "name": "Sarah Chen", "email": "sarah@example.com" }
//   ],
//   "transcript": "full transcript text here..."
// }

import { readFileSync } from "node:fs";
import { captureManualMeeting, type CaptureManualMeetingInput } from "./captureManualMeeting";
import { runFullPipeline } from "../pipeline/runFullPipeline";
import { runCli } from "../util/runCli";

async function readInput(): Promise<CaptureManualMeetingInput> {
  const filePath = process.argv[2];

  const raw = filePath
    ? readFileSync(filePath, "utf-8")
    : readFileSync(0, "utf-8"); // fd 0 = stdin

  if (!raw.trim()) {
    throw new Error(
      "No input provided. Usage: npm run capture -- path/to/meeting.json (or pipe JSON via stdin)."
    );
  }

  return JSON.parse(raw);
}

async function main() {
  const input = await readInput();

  const result = await captureManualMeeting(input);

  console.log("Meeting captured:");
  console.log(`  meeting_id:      ${result.meetingId}`);
  console.log(`  transcript_id:   ${result.transcriptId}`);
  console.log(`  owner_id:        ${result.ownerId}`);
  console.log(`  participant_ids: ${result.participantIds.join(", ") || "(none)"}`);

  // Auto-process right after capture, same as the dashboard's capture
  // endpoint — a meeting shouldn't need a separate manual processing step
  // before it's useful. Kept in its own try/catch: the meeting is already
  // safely written at this point, so a processing failure here shouldn't
  // look like the capture itself failed (rerun with `npm run process --
  // <meeting_id>` if this happens).
  try {
    const processed = await runFullPipeline(result.meetingId);
    console.log("Meeting processed:");
    console.log(`  insights_id: ${processed.processed.insightsId}`);
    console.log(`  chunks:      ${processed.processed.chunkCount}`);
  } catch (err) {
    console.error(
      "Auto-processing failed (meeting was still captured):",
      err instanceof Error ? err.message : err
    );
  }
}

runCli("Capture", main);
