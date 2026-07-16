// Stage 2 CLI: process a captured meeting (extract suggested takeaways,
// action items, and follow-ups). Notifications no longer fire automatically
// here — they wait until the meeting's suggestions are reviewed/approved on
// the dashboard (see src/pipeline/reviewMeeting.ts), which is what now
// triggers them.
//
// Usage:
//   npm run pipeline -- <meetingId>

import { runFullPipeline } from "./runFullPipeline";
import { runCli } from "../util/runCli";

async function main() {
  const meetingId = process.argv[2];
  if (!meetingId) {
    throw new Error("Usage: npm run pipeline -- <meetingId>");
  }

  const { processed } = await runFullPipeline(meetingId);

  console.log("Meeting processed:");
  console.log(`  insights_id: ${processed.insightsId}`);
  console.log(`  chunks:      ${processed.chunkCount}`);
  console.log("Suggestions generated — review and approve on the dashboard to trigger notifications.");
}

runCli("Pipeline", main);
