// Push of one approved Action Item into Asana as a task — triggered by the
// manual "Send to Asana" button on the meeting detail page's approved
// Action Items list (never automatic, and never for Follow-ups — those are
// explicitly other people's tasks, not the owner's own, see
// db/schema.ts's meeting_insights comment).
//
// As of the per-user Asana OAuth work (src/integrations/oauth/), the caller
// (sendActionItemToAsana in queries.ts) passes the ACTING user's own OAuth
// access token here when they've connected their own Asana account, so the
// task is genuinely attributed to them. `accessToken` falls back to the
// legacy global Personal Access Token (ASANA_ACCESS_TOKEN) when omitted —
// kept working for anyone who hasn't connected their own account yet (see
// .env.example). Workspace/project stay shared env vars either way
// (ASANA_WORKSPACE_GID/ASANA_PROJECT_GID) — everyone's tasks land in the
// same dedicated "good-wrap" project, only the acting token/assignee changes.

import { requireEnv } from "../util/env";

const ASANA_API_BASE = "https://app.asana.com/api/1.0";

export interface CreateAsanaTaskInput {
  /** Action item text — becomes the Asana task's name. */
  text: string;
  /** Meeting topic, included in the task notes for context. */
  meetingTopic: string;
  /** The acting user's own Asana OAuth access token, if they've connected
   * one. Falls back to the legacy ASANA_ACCESS_TOKEN PAT when omitted. */
  accessToken?: string;
}

export interface CreateAsanaTaskResult {
  taskGid: string;
  permalinkUrl: string;
}

export async function createAsanaTask(input: CreateAsanaTaskInput): Promise<CreateAsanaTaskResult> {
  const token = input.accessToken ?? requireEnv("ASANA_ACCESS_TOKEN");
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

/** "Unsend" — permanently deletes the Asana task itself (not just the local
 * link to it), triggered by the meeting detail page's "Remove from Asana"
 * action (see unsendActionItemFromAsana in queries.ts). Same acting-user
 * access token fallback as createAsanaTask above. A 404 from Asana means the
 * task is already gone (e.g. someone deleted it directly in Asana) — treated
 * as success so the local asanaTaskGid still gets cleared either way. */
export async function deleteAsanaTask(taskGid: string, accessToken?: string): Promise<void> {
  const token = accessToken ?? requireEnv("ASANA_ACCESS_TOKEN");

  const res = await fetch(`${ASANA_API_BASE}/tasks/${taskGid}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Asana task deletion failed (${res.status}): ${body}`);
  }
}
