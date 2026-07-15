// Stage 3: chat-style ping notifier — STUB.
//
// Which chat tool (Slack, Teams, something else) is still an open decision
// (Project-Handoff-Brief.md Section 6). This prints what would be sent and
// logs "pending" rather than blocking the pipeline on that choice. Once
// Peter picks a tool, replace the body of `send` with a real API call
// (e.g. Slack's chat.postMessage via a webhook or bot token) and only
// return "sent" once delivery is confirmed.

import type { MeetingNotificationPayload, Notifier } from "../notifier";

function formatChatMessage(payload: MeetingNotificationPayload): string {
  const topTakeaway = payload.takeaways[0];
  const topActionItem = payload.actionItems[0];
  const topFollowUp = payload.followUps[0];

  const parts = [`✅ Reviewed: *${payload.topic}*`];
  if (topTakeaway) parts.push(`Top takeaway: ${topTakeaway}`);
  if (topActionItem) parts.push(`Action item: ${topActionItem.text}`);
  if (topFollowUp) {
    const who = topFollowUp.person ? ` (with ${topFollowUp.person})` : "";
    parts.push(`Follow-up: ${topFollowUp.text}${who}`);
  }

  return parts.join("\n");
}

export const chatNotifier: Notifier = {
  channel: "chat",
  async send(payload) {
    console.log("\n--- [chat notifier — STUB, no chat tool configured] ---");
    console.log(formatChatMessage(payload));
    console.log("--- end chat message ---\n");
    return "pending";
  },
};
