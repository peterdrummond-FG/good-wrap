// Thin fetch wrapper around the Stage 4 API (src/server/ in the project
// root). Types here are hand-kept in sync with src/server/queries.ts and
// app.ts — this is a POC, not worth a shared-types package yet.

export interface MeetingListItem {
  id: string;
  topic: string;
  startTime: string;
  durationMinutes: number | null;
  source: "manual" | "zoom";
  participants: string[];
  processed: boolean;
  topTakeaways: string[];
}

export type FollowUpTiming = "tomorrow" | "this_week" | "next_week" | "unspecified";

export interface FollowUpItem {
  text: string;
  person: string | null;
  timing: FollowUpTiming;
}

export interface FollowUpWithMeeting extends FollowUpItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: string;
}

export interface MeetingDetail {
  id: string;
  topic: string;
  startTime: string;
  durationMinutes: number | null;
  source: "manual" | "zoom";
  participants: string[];
  transcript: string | null;
  insights: { keywords: string[]; takeaways: string[]; followUps: FollowUpItem[] } | null;
}

export interface CaptureMeetingInput {
  topic: string;
  startTime: string;
  durationMinutes?: number;
  participants: { name?: string; email?: string }[];
  transcript: string;
}

export interface AskResult {
  answer: string;
  sources: { meetingId: string; topic: string; startTime: string }[];
}

// Base URL of the Stage 4 API. Empty string in local dev, where Vite's
// proxy (vite.config.ts) forwards /api to the Fastify server on :4000.
// In production, set VITE_API_BASE_URL (build-time env var) to wherever
// the backend is actually hosted (e.g. a Railway domain) — this dashboard
// and the API don't share an origin once they're on separate hosts.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(body?.error ?? `Request to ${path} failed (${res.status})`);
  }

  return body as T;
}

export function fetchMeetings(): Promise<{ meetings: MeetingListItem[] }> {
  return request("/meetings");
}

export function fetchMeetingDetail(id: string): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}`);
}

export interface CaptureMeetingResult {
  meetingId: string;
  transcriptId: string;
  ownerId: string;
  participantIds: string[];
  // Capture always succeeds independently of processing — see app.ts's
  // POST /api/meetings. `processed` reflects whether the automatic Stage 2
  // run right after capture actually completed.
  processed: boolean;
  processingError?: string;
}

export function captureMeeting(input: CaptureMeetingInput): Promise<CaptureMeetingResult> {
  return request("/meetings", { method: "POST", body: JSON.stringify(input) });
}

export function processMeeting(id: string) {
  return request(`/meetings/${id}/process`, { method: "POST" });
}

export function askQuestion(question: string): Promise<AskResult> {
  return request("/ask", { method: "POST", body: JSON.stringify({ question }) });
}

export function fetchFollowUps(): Promise<{ followUps: FollowUpWithMeeting[] }> {
  return request("/followups");
}
