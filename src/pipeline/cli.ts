// Stage 2 CLI: run the processing pipeline for one already-captured meeting.
//
// Usage:
//   npm run process -- <meetingId>

import { processMeeting } from "./processMeeting";
import { runCli } from "../util/runCli";

async function main() {
  const meetingId = process.argv[2];
  if (!meetingId) {
    throw new Error("Usage: npm run process -- <meetingId>");
  }

  const result = await processMeeting(meetingId);

  console.log("Meeting processed:");
  console.log(`  meeting_id:  ${result.meetingId}`);
  console.log(`  insights_id: ${result.insightsId}`);
  console.log(`  chunks:      ${result.chunkCount}`);
}

runCli("Processing", main);
