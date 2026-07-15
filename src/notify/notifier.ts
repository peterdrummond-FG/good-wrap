// Stage 3: shared notifier contract. Each channel (email, chat, dashboard)
// implements this so sendNotifications.ts can treat them uniformly and log
// a consistent notifications_log row per channel per meeting.

import type { FollowUpItem } from "../../db/schema";

export interface MeetingNotificationPayload {
  meetingId: string;
  topic: string;
  startTime: Date;
  keywords: string[];
  takeaways: string[];
  followUps: FollowUpItem[];
}

// Matches db/schema.ts's notification_status enum.
export type NotificationOutcome = "sent" | "pending" | "failed";

export interface Notifier {
  channel: "email" | "chat" | "dashboard";
  send(payload: MeetingNotificationPayload): Promise<NotificationOutcome>;
}
