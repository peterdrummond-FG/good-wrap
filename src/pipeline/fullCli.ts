// Full Stage 2 + Stage 3 CLI: process a captured meeting and fire notifications.
//
// Usage:
//   npm run pipeline -- <meetingId>

import { runFullPipeline } from "./runFullPipeline";
import { closeDb } from "../db/client";

async function main() {
  const meetingId = process.argv[2];
  if (!meetingId) {
    throw new Error("Usage: npm run pipeline -- <meetingId>");
  }

  const { processed, notified } = await runFullPipeline(meetingId);

  console.log("Meeting processed:");
  console.log(`  insights_id: ${processed.insightsId}`);
  console.log(`  chunks:      ${processed.chunkCount}`);
  console.log("Notifications sent:");
  for (const r of notified.results) {
    console.log(`  ${r.channel.padEnd(10)} ${r.status}`);
  }
}

main()
  .catch((err) => {
    console.error("Pipeline failed:", err.message ?? err);
    if (err.cause) console.error("Caused by:", err.cause.message ?? err.cause);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
