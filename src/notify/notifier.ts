// Stage 3: shared notifier contract. Each channel (email, chat, dashboard)
// implements this so sendNotifications.ts can treat them uniformly and log
// a consistent notifications_log row per channel per meeting.

import type { ActionItem, FollowUpItem } from "../../db/schema";

// Notifications only fire once a meeting has been reviewed (see
// reviewMeeting.ts), and only include items Peter actually approved — the
// `approved` flag is still present on these types but will always be true
// by the time a payload reaches a notifier, since sendNotifications.ts
// filters before building this payload.
export interface MeetingNotificationPayload {
  meetingId: string;
  topic: string;
  startTime: Date;
  keywords: string[];
  takeaways: string[];
  actionItems: ActionItem[];
  followUps: FollowUpItem[];
}

// Matches db/schema.ts's notification_status enum.
export type NotificationOutcome = "sent" | "pending" | "failed";

export interface Notifier {
  channel: "email" | "chat" | "dashboard";
  send(payload: MeetingNotificationPayload): Promise<NotificationOutcome>;
}
