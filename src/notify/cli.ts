// Stage 3 CLI: fire notifications for a meeting already processed by Stage 2.
//
// Usage:
//   npm run notify -- <meetingId>

import { sendNotifications } from "./sendNotifications";
import { closeDb } from "../db/client";

async function main() {
  const meetingId = process.argv[2];
  if (!meetingId) {
    throw new Error("Usage: npm run notify -- <meetingId>");
  }

  const result = await sendNotifications(meetingId);

  console.log("Notifications sent:");
  for (const r of result.results) {
    console.log(`  ${r.channel.padEnd(10)} ${r.status}`);
  }
}

main()
  .catch((err) => {
    console.error("Notify failed:", err.message ?? err);
    if (err.cause) console.error("Caused by:", err.cause.message ?? err.cause);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
