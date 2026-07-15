// Stage 3: dashboard flag.
//
// This isn't a delivery to an external service — the notifications_log row
// itself IS the flag. Stage 4's dashboard will query this table for
// channel = 'dashboard' rows to mark a meeting as "newly processed". So this
// notifier's job is trivial: confirm the meeting is ready to be flagged.
// The actual flag write happens in sendNotifications.ts, same as every
// other channel.

import type { Notifier } from "../notifier";

export const dashboardFlagNotifier: Notifier = {
  channel: "dashboard",
  async send() {
    return "sent";
  },
};
