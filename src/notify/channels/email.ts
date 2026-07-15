// Stage 3: email notifier — STUB.
//
// No email provider has been chosen yet (see Project-Handoff-Brief.md
// Section 6, "open decisions"). Rather than block the pipeline on that
// choice, this prints what would be sent and logs the channel as "pending"
// (not "sent" — that word means actually delivered). Swap the body of
// `send` for a real provider call (Resend, SMTP via nodemailer, etc.) once
// Peter picks one, and only return "sent" once delivery is confirmed.

import type { MeetingNotificationPayload, Notifier } from "../notifier";

function formatEmailBody(payload: MeetingNotificationPayload): string {
  const lines = [
    `Meeting: ${payload.topic}`,
    `When: ${payload.startTime.toISOString()}`,
    "",
    `Keywords: ${payload.keywords.join(", ") || "(none)"}`,
    "",
    "Takeaways:",
    ...(payload.takeaways.length ? payload.takeaways.map((t) => `  - ${t}`) : ["  (none)"]),
    "",
    "Follow-ups:",
    ...(payload.followUps.length
      ? payload.followUps.map((f) => {
          const who = f.person ? ` (with ${f.person})` : "";
          const when = f.timing !== "unspecified" ? ` [${f.timing.replace("_", " ")}]` : "";
          return `  - ${f.text}${who}${when}`;
        })
      : ["  (none)"]),
  ];
  return lines.join("\n");
}

export const emailNotifier: Notifier = {
  channel: "email",
  async send(payload) {
    console.log("\n--- [email notifier — STUB, no provider configured] ---");
    console.log(formatEmailBody(payload));
    console.log("--- end email ---\n");
    return "pending";
  },
};
