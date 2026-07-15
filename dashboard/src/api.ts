// Thin fetch wrapper around the Stage 4 API (src/server/ in the project
// root). Types here are hand-kept in sync with src/server/queries.ts and
// app.ts — this is a POC, not worth a shared-types package yet.

export type ReviewStatus = "pending" | "needs_review" | "reviewed";

export interface MeetingListItem {
  id: string;
  topic: string;
  startTime: string;
  durationMinutes: number | null;
  source: "manual" | "zoom";
  participants: string[];
  reviewStatus: ReviewStatus;
  /** Top 3 APPROVED takeaways — empty until reviewed. */
  topTakeaways: string[];
}

export type FollowUpTiming = "tomorrow" | "this_week" | "next_week" | "unspecified";

// Takeaways: plain suggest/approve, no owner or timing concept.
export interface SuggestionItem {
  text: string;
  approved: boolean;
}

// Action items: things Peter needs to do himself.
export interface ActionItem {
  text: string;
  timing: FollowUpTiming;
  approved: boolean;
}

// Follow-ups: things waiting on someone else, or unconfirmed items.
export interface FollowUpItem {
  text: string;
  person: string | null;
  timing: FollowUpTiming;
  approved: boolean;
}

export interface FollowUpWithMeeting extends FollowUpItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: string;
}

export interface ActionItemWithMeeting extends ActionItem {
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
  reviewStatus: ReviewStatus;
  insights: {
    keywords: string[];
    // Full candidate sets (approved AND unapproved) — the review UI needs
    // every suggestion, not just what's currently approved.
    takeaways: SuggestionItem[];
    actionItems: ActionItem[];
    followUps: FollowUpItem[];
    reviewedAt: string | null;
  } | null;
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
  // Only send Content-Type: application/json when there's actually a body.
  // Fastify's default JSON body parser rejects a request that claims a JSON
  // content-type but sends an empty body (FST_ERR_CTP_EMPTY_JSON_BODY) — hit
  // by processMeeting()/askQuestion() callers with no payload, e.g. the
  // "Reprocess meeting" button (POST with no body).
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
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
  // run right after capture actually completed (generated suggestions to
  // review) — separate from reviewStatus, which tracks whether Peter has
  // since approved any of them.
  processed: boolean;
  processingError?: string;
}

export function captureMeeting(input: CaptureMeetingInput): Promise<CaptureMeetingResult> {
  return request("/meetings", { method: "POST", body: JSON.stringify(input) });
}

export function processMeeting(id: string) {
  return request(`/meetings/${id}/process`, { method: "POST" });
}

export interface UpdateMeetingInput {
  /** Any field left undefined/omitted is unchanged. */
  topic?: string;
  startTime?: string;
  durationMinutes?: number | null;
  /** When provided, REPLACES the meeting's entire participant list. */
  participants?: { name?: string; email?: string }[];
}

export function updateMeeting(id: string, input: UpdateMeetingInput): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export interface UpdateMeetingInsightsInput {
  /** Any field left undefined/omitted is unchanged. Doesn't affect reviewStatus. */
  keywords?: string[];
}

export function updateMeetingInsights(
  id: string,
  input: UpdateMeetingInsightsInput
): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}/insights`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteMeeting(id: string): Promise<Record<string, never>> {
  return request(`/meetings/${id}`, { method: "DELETE" });
}

export interface SubmitReviewInput {
  keywords?: string[];
  takeaways: SuggestionItem[];
  actionItems: ActionItem[];
  followUps: FollowUpItem[];
}

export interface SubmitReviewResult {
  meetingId: string;
  /** True if this save is what moved the meeting from needs_review to reviewed. */
  justReviewed: boolean;
  meeting: MeetingDetail;
}

// Submits picks/edits from the review UI. The first time a meeting is
// reviewed (reviewedAt null -> set), the backend fires email/chat
// notifications with only the approved items — later re-saves persist
// normally without re-notifying.
export function submitMeetingReview(id: string, input: SubmitReviewInput): Promise<SubmitReviewResult> {
  return request(`/meetings/${id}/review`, { method: "POST", body: JSON.stringify(input) });
}

export function askQuestion(question: string): Promise<AskResult> {
  return request("/ask", { method: "POST", body: JSON.stringify({ question }) });
}

export function fetchFollowUps(): Promise<{
  followUps: FollowUpWithMeeting[];
  actionItems: ActionItemWithMeeting[];
}> {
  return request("/followups");
}
