// Thin fetch wrapper around the Stage 4 API (src/server/ in the project
// root). Types here are hand-kept in sync with src/server/queries.ts and
// app.ts — this is a POC, not worth a shared-types package yet.

import { supabase } from "./lib/supabaseClient";

export type ReviewStatus = "pending" | "needs_review" | "reviewed";

// See db/schema.ts's companies comment — Flippen Group's portfolio companies
// (plus Flippen Group itself, isInternal: true) that a meeting can be tagged
// with.
export interface Company {
  id: string;
  name: string;
  slug: string;
  isInternal: boolean;
}

export interface MeetingListItem {
  id: string;
  topic: string;
  startTime: string;
  durationMinutes: number | null;
  source: "manual" | "upload" | "zoom";
  participants: string[];
  reviewStatus: ReviewStatus;
  /** Top 3 APPROVED takeaways — empty until reviewed. */
  topTakeaways: string[];
  /** Fully automatic, no approval step — used for the Meetings list search. */
  keywords: string[];
  /** Null until AI-classified or manually tagged. */
  company: Company | null;
}

// Replaced "timing" (today/tomorrow/this_week/next_week/unspecified) with
// "urgency" 2026-07-16 — see db/schema.ts for the full rationale.
export type Urgency = "high" | "medium" | "low";

// Takeaways: plain suggest/approve, no owner or urgency concept.
export interface SuggestionItem {
  text: string;
  approved: boolean;
}

// Action items: things Peter needs to do himself.
export interface ActionItem {
  text: string;
  urgency: Urgency;
  approved: boolean;
  /** Set once pushed to Asana — see sendActionItemToAsana below. */
  asanaTaskGid?: string;
  /** Greys the item out — see setActionItemDone below. */
  done?: boolean;
}

// Follow-ups: things waiting on someone else, or unconfirmed items.
export interface FollowUpItem {
  text: string;
  person: string | null;
  urgency: Urgency;
  approved: boolean;
  /** Same meaning as ActionItem.done above. */
  done?: boolean;
}

export interface FollowUpWithMeeting extends FollowUpItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: string;
  /** This item's position in the meeting's own followUps array — needed to
   * address it for done/delete. */
  index: number;
}

export interface ActionItemWithMeeting extends ActionItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: string;
  /** Same as FollowUpWithMeeting.index, for actionItems. */
  index: number;
}

export interface MeetingDetail {
  id: string;
  topic: string;
  startTime: string;
  durationMinutes: number | null;
  source: "manual" | "upload" | "zoom";
  participants: string[];
  transcript: string | null;
  reviewStatus: ReviewStatus;
  company: Company | null;
  /** Null until a company is first set; "manual" once Peter has ever picked
   * or corrected it — see setMeetingCompany below. */
  companySource: "ai" | "manual" | null;
  insights: {
    keywords: string[];
    // Full candidate sets (approved AND unapproved) — the review UI needs
    // every suggestion, not just what's currently approved.
    takeaways: SuggestionItem[];
    actionItems: ActionItem[];
    followUps: FollowUpItem[];
    actionItemsReviewedAt: string | null;
    followUpsReviewedAt: string | null;
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
  // Only send Content-Type: application/json when there's actually a JSON
  // body. Fastify's default JSON body parser rejects a request that claims a
  // JSON content-type but sends an empty body (FST_ERR_CTP_EMPTY_JSON_BODY)
  // — hit by processMeeting()/askQuestion() callers with no payload, e.g.
  // the "Reprocess meeting" button (POST with no body). A FormData body
  // (uploadMeetingTranscript below) must NOT get this header — the browser
  // sets its own multipart/form-data content-type with the correct boundary.
  const isFormData = options?.body instanceof FormData;
  // Added 2026-07-20 alongside real login — every request now carries the
  // current Supabase session's token, if any, so the backend's requireAuth
  // (src/server/auth.ts) can resolve who's calling. getSession() resolves
  // near-instantly from local storage/memory once the client has
  // initialized; it's not a network round trip on every call.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    ...options,
    headers: {
      ...(options?.body && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...options?.headers,
    },
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(body?.error ?? `Request to ${path} failed (${res.status})`);
  }

  return body as T;
}

// Resolved via GET /api/me, which (as of 2026-07-20) reflects whoever the
// current request's Supabase session/worker key actually authenticated as
// (see src/server/auth.ts) — not the old DEFAULT_OWNER_EMAIL single-user
// stand-in.
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

export function fetchCurrentUser(): Promise<{ user: CurrentUser }> {
  return request("/me");
}

export function fetchMeetings(): Promise<{ meetings: MeetingListItem[] }> {
  return request("/meetings");
}

export function fetchCompanies(): Promise<{ companies: Company[] }> {
  return request("/companies");
}

// Manual re-tag/correction (see CompanyTag.vue's picker) — always wins over
// Claude's own guess from here on. Pass companyId: null to clear the tag.
export function setMeetingCompany(id: string, companyId: string | null): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}/company`, { method: "PATCH", body: JSON.stringify({ companyId }) });
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

// Metadata extractMeetingMetadata (src/ingest/extractMeetingMetadata.ts)
// inferred from the raw file — surfaced so a bad guess is visible right
// after upload rather than only discoverable by opening the meeting page.
export interface ExtractedMeetingMetadata {
  topic: string;
  startTime: string;
  durationMinutes?: number;
  participants: { name?: string; email?: string }[];
}

export interface UploadMeetingResult extends CaptureMeetingResult {
  metadata: ExtractedMeetingMetadata;
}

// File-upload capture (Peter's "upload a transcript" flow, see CaptureForm.vue)
// — a single .txt file with no structured metadata attached; the backend
// infers topic/date/duration/participants from the raw text itself.
export function uploadMeetingTranscript(file: File): Promise<UploadMeetingResult> {
  const formData = new FormData();
  formData.append("file", file);
  return request("/meetings/upload", { method: "POST", body: formData });
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
  /** Optional — takeaways aren't reviewed/edited here anymore; omit to leave unchanged. */
  takeaways?: SuggestionItem[];
  /** Optional — each review column now saves independently; omit the category you're not saving. */
  actionItems?: ActionItem[];
  /** Optional — each review column now saves independently; omit the category you're not saving. */
  followUps?: FollowUpItem[];
}

export interface SubmitReviewResult {
  meetingId: string;
  /** True if this save is what moved Action Items from needs_review to reviewed. */
  justReviewedActionItems: boolean;
  /** True if this save is what moved Follow-ups from needs_review to reviewed. */
  justReviewedFollowUps: boolean;
  meeting: MeetingDetail;
}

// Submits picks/edits from one review panel (Action Items or Follow-ups —
// each saves independently, see MeetingDetail.vue). The first time THAT
// category is reviewed (its own reviewed-at null -> set), the backend fires
// email/chat notifications with whatever's currently approved — later
// re-saves persist normally without re-notifying.
export function submitMeetingReview(id: string, input: SubmitReviewInput): Promise<SubmitReviewResult> {
  return request(`/meetings/${id}/review`, { method: "POST", body: JSON.stringify(input) });
}

export type RegenerateCategory = "takeaways" | "actionItems" | "followUps";

// Fetches a fresh Claude extraction and overwrites just ONE category —
// doesn't touch reviewedAt or fire notifications. Triggered by the pencil
// icon on a review column.
export function regenerateInsightCategory(
  id: string,
  category: RegenerateCategory
): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}/regenerate`, { method: "POST", body: JSON.stringify({ category }) });
}

export function askQuestion(question: string): Promise<AskResult> {
  return request("/ask", { method: "POST", body: JSON.stringify({ question }) });
}

export interface SendActionItemToAsanaResult {
  taskGid: string;
  /** True if this item was already sent — no new task was created. */
  alreadySent: boolean;
  meeting: MeetingDetail;
}

// Manual per-item push (Action Items only — see the "Send to Asana" button
// on the meeting detail page's approved list). `index` is the item's
// position in the meeting's actionItems array.
export function sendActionItemToAsana(id: string, index: number): Promise<SendActionItemToAsanaResult> {
  return request(`/meetings/${id}/action-items/${index}/send-to-asana`, { method: "POST" });
}

// Toggles done — greys the item out but keeps it listed (delete below
// removes it outright). `index` is this item's position in the meeting's
// own actionItems/followUps array.
export function setActionItemDone(
  id: string,
  index: number,
  done: boolean
): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}/action-items/${index}/done`, {
    method: "POST",
    body: JSON.stringify({ done }),
  });
}

export function deleteActionItem(id: string, index: number): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}/action-items/${index}`, { method: "DELETE" });
}

export function setFollowUpDone(
  id: string,
  index: number,
  done: boolean
): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}/follow-ups/${index}/done`, {
    method: "POST",
    body: JSON.stringify({ done }),
  });
}

export function deleteFollowUp(id: string, index: number): Promise<{ meeting: MeetingDetail }> {
  return request(`/meetings/${id}/follow-ups/${index}`, { method: "DELETE" });
}

export function fetchFollowUps(): Promise<{
  followUps: FollowUpWithMeeting[];
  actionItems: ActionItemWithMeeting[];
}> {
  return request("/followups");
}

// --- Manual person-history page (#9) — on-demand, no calendar integration ---------

export interface PersonListItem {
  id: string;
  name: string;
  /** Set directly on the person page — never inferred from meeting history. */
  companies: Company[];
}

export function fetchPeople(): Promise<{ people: PersonListItem[] }> {
  return request("/people");
}

export interface PersonMeetingSummary {
  meetingId: string;
  topic: string;
  startTime: string;
  reviewStatus: ReviewStatus;
}

export interface PersonFollowUp extends FollowUpItem {
  meetingId: string;
  meetingTopic: string;
  meetingStartTime: string;
}

export interface PersonDetail {
  id: string;
  name: string;
  /** Set directly on the person page — never inferred from meeting history. */
  companies: Company[];
  meetings: PersonMeetingSummary[];
  /** Every approved follow-up involving this person — no "done" concept yet, so not just outstanding ones. */
  followUps: PersonFollowUp[];
}

export function fetchPersonDetail(id: string): Promise<{ person: PersonDetail }> {
  return request(`/people/${id}`);
}

// Replaces the person's full set of tagged companies in one call (same
// "replace the whole list" convention as updateMeeting's participants) —
// always a direct pick from the person page, never inferred.
export function setPersonCompanies(id: string, companyIds: string[]): Promise<{ person: PersonDetail }> {
  return request(`/people/${id}/companies`, { method: "PATCH", body: JSON.stringify({ companyIds }) });
}

export interface PersonSummaryResult {
  summary: string;
  sources: { meetingId: string; topic: string; startTime: string }[];
}

// Triggers a real Claude call — only call this from an explicit user action
// (e.g. a "Generate summary" button), never automatically on page load.
export function fetchPersonSummary(id: string): Promise<PersonSummaryResult> {
  return request(`/people/${id}/summary`, { method: "POST" });
}

// --- Account page: Zoom/Asana connections, local setup, team (#admin) -------------
// Backs the single persistent Account screen (AccountPage.vue) — see
// src/server/routes/{integrations,workerKeys,admin}.ts.

export type IntegrationProviderName = "zoom" | "asana";

export interface IntegrationConnection {
  provider: IntegrationProviderName;
  connected: boolean;
  accountEmail: string | null;
  connectedAt: string | null;
}

export function fetchIntegrations(): Promise<{ connections: IntegrationConnection[] }> {
  return request("/integrations");
}

export function getIntegrationAuthorizeUrl(
  provider: IntegrationProviderName
): Promise<{ authorizeUrl: string }> {
  return request(`/integrations/${provider}/authorize`);
}

export function disconnectIntegration(provider: IntegrationProviderName): Promise<Record<string, never>> {
  return request(`/integrations/${provider}`, { method: "DELETE" });
}

export interface WorkerKeySummary {
  id: string;
  keyPrefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function fetchWorkerKeys(): Promise<{ workerKeys: WorkerKeySummary[] }> {
  return request("/worker-keys");
}

export interface CreatedWorkerKey {
  id: string;
  keyPrefix: string;
  /** Shown exactly once — never retrievable again after this response. */
  workerKey: string;
}

export function createWorkerKey(label?: string): Promise<CreatedWorkerKey> {
  return request("/worker-keys", { method: "POST", body: JSON.stringify({ label }) });
}

export function revokeWorkerKey(id: string): Promise<Record<string, never>> {
  return request(`/worker-keys/${id}`, { method: "DELETE" });
}

export interface SetupScript {
  filename: string;
  contents: string;
}

// Issues a fresh personal worker key behind the scenes and bakes it into a
// personalized, downloadable .command file — see
// src/server/generateSetupScript.ts.
export function generateSetupScript(): Promise<SetupScript> {
  return request("/integrations/setup-script", { method: "POST" });
}

// --- Team (admin-only) -------------------------------------------------------------

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  disabledAt: string | null;
  createdAt: string;
}

export function fetchAdminUsers(): Promise<{ users: AdminUser[] }> {
  return request("/admin/users");
}

// The entire "invite a teammate" mechanism — no invite email is sent; the
// person just logs in with Google/Microsoft themselves afterward and
// auto-links to this row by email match (see src/server/auth.ts).
export function inviteUser(input: { name: string; email: string; role?: "admin" | "member" }): Promise<{ user: AdminUser }> {
  return request("/admin/users", { method: "POST", body: JSON.stringify(input) });
}

export function setUserDisabled(id: string, disabled: boolean): Promise<{ ok: true }> {
  return request(`/admin/users/${id}/disabled`, { method: "POST", body: JSON.stringify({ disabled }) });
}
