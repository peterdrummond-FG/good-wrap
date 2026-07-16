// Server-to-server push of one approved Action Item into Asana as a task —
// triggered by the manual "Send to Asana" button on the meeting detail
// page's approved Action Items list (never automatic, and never for
// Follow-ups — those are explicitly other people's tasks, not Peter's own,
// see db/schema.ts's meeting_insights comment).
//
// Requires a Personal Access Token (ASANA_ACCESS_TOKEN) plus a
// workspace/project to create tasks in (ASANA_WORKSPACE_GID/
// ASANA_PROJECT_GID — see .env.example). Tasks are created in a dedicated
// "good-wrap" project rather than Flippen Group's ~100 shared client/team
// project boards, and with assignee: "me" so they also land in the token
// owner's personal Asana "My Tasks" list.

import { requireEnv } from "../util/env";

const ASANA_API_BASE = "https://app.asana.com/api/1.0";

export interface CreateAsanaTaskInput {
  /** Action item text — becomes the Asana task's name. */
  text: string;
  /** Meeting topic, included in the task notes for context. */
  meetingTopic: string;
}

export interface CreateAsanaTaskResult {
  taskGid: string;
  permalinkUrl: string;
}

export async function createAsanaTask(input: CreateAsanaTaskInput): Promise<CreateAsanaTaskResult> {
  const token = requireEnv("ASANA_ACCESS_TOKEN");
  const workspace = requireEnv("ASANA_WORKSPACE_GID");
  const project = requireEnv("ASANA_PROJECT_GID");

  const res = await fetch(`${ASANA_API_BASE}/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        name: input.text,
        notes: `From good-wrap meeting: ${input.meetingTopic}`,
        workspace,
        projects: [project],
        assignee: "me",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Asana task creation failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { data: { gid: string; permalink_url: string } };
  return { taskGid: json.data.gid, permalinkUrl: json.data.permalink_url };
}
