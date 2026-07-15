// Stage 3: fire notifications once Stage 2 has produced meeting_insights.
//
// Reads the most recent meeting_insights row for a meeting, then runs each
// channel notifier and logs one notifications_log row per channel — this is
// the "dashboard flag" itself for the dashboard channel, and an actual (or
// stubbed) delivery attempt for email/chat.

import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { dashboardFlagNotifier } from "./channels/dashboardFlag";
import { emailNotifier } from "./channels/email";
import { chatNotifier } from "./channels/chat";
import type { MeetingNotificationPayload, Notifier, NotificationOutcome } from "./notifier";
import { normalizeActionItems, normalizeFollowUps, normalizeTakeaways } from "../server/queries";

const notifiers: Notifier[] = [emailNotifier, chatNotifier, dashboardFlagNotifier];

export interface SendNotificationsResult {
  meetingId: string;
  results: { channel: string; status: NotificationOutcome }[];
}

export async function sendNotifications(meetingId: string): Promise<SendNotificationsResult> {
  const [meeting] = await db
    .select()
    .from(schema.meetings)
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  if (!meeting) {
    throw new Error(`No meeting found for id ${meetingId}`);
  }

  const [insights] = await db
    .select()
    .from(schema.meetingInsights)
    .where(eq(schema.meetingInsights.meetingId, meetingId))
    .orderBy(desc(schema.meetingInsights.generatedAt))
    .limit(1);
  if (!insights) {
    throw new Error(
      `No meeting_insights found for meeting ${meetingId}. Run the Stage 2 pipeline ` +
        `(npm run process -- ${meetingId}) first.`
    );
  }

  // Takeaways/action items/follow-ups are suggest-then-approve (see
  // db/schema.ts) — only send what Peter actually approved during review,
  // never the raw candidate set Claude proposed. Normalize first since a
  // meeting reviewed via a direct DB write or an old pre-migration row could
  // otherwise reach here in a shape these types don't expect.
  const payload: MeetingNotificationPayload = {
    meetingId,
    topic: meeting.topic,
    startTime: meeting.startTime,
    keywords: insights.keywords ?? [],
    takeaways: normalizeTakeaways(insights.takeaways)
      .filter((t) => t.approved)
      .map((t) => t.text),
    actionItems: normalizeActionItems(insights.actionItems).filter((a) => a.approved),
    followUps: normalizeFollowUps(insights.followUps).filter((f) => f.approved),
  };

  const results: { channel: string; status: NotificationOutcome }[] = [];

  for (const notifier of notifiers) {
    let status: NotificationOutcome;
    try {
      status = await notifier.send(payload);
    } catch (err) {
      console.error(`Notifier "${notifier.channel}" failed:`, err);
      status = "failed";
    }

    await db.insert(schema.notificationsLog).values({
      meetingId,
      channel: notifier.channel,
      status,
      sentAt: status === "sent" ? new Date() : null,
    });

    results.push({ channel: notifier.channel, status });
  }

  return { meetingId, results };
}
