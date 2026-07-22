// Zoom Server-to-Server OAuth + webhook plumbing (see POST /api/webhooks/zoom
// in app.ts, and src/ingest/captureFromZoomWebhook.ts for the orchestration
// that uses this). Requires a Server-to-Server OAuth app in the Zoom
// Marketplace (scopes: cloud_recording:read, meeting:read) and a webhook
// subscription for "Recording Transcript files have completed" pointed at
// this API — see .env.example for the four required env vars.

import { createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "../util/env";

// --- OAuth token (client_credentials-style "account credentials" grant) -----------

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/** Cached in-memory until shortly before expiry — Zoom's tokens are short-lived
 * (~1hr), and refetching one per webhook delivery would be wasteful. */
export async function getZoomAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const accountId = requireEnv("ZOOM_ACCOUNT_ID");
  const clientId = requireEnv("ZOOM_CLIENT_ID");
  const clientSecret = requireEnv("ZOOM_CLIENT_SECRET");
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    { method: "POST", headers: { Authorization: `Basic ${basicAuth}` } }
  );
  if (!res.ok) {
    throw new Error(`Zoom OAuth token request failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.token;
}

/** Downloads a cloud recording file (e.g. the TRANSCRIPT entry in a
 * recording.transcript_completed payload's recording_files). */
export async function downloadRecordingFile(downloadUrl: string, accessToken: string): Promise<string> {
  const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`Zoom recording download failed (${res.status}): ${await res.text()}`);
  }
  return res.text();
}

// --- past-meeting participants ------------------------------------------------------
// Fills in the full attendee list beyond just the host (recording.transcript_
// completed's payload only reliably gives host_email — see
// captureFromZoomWebhook.ts). Uses GET /past_meetings/{uuid}/participants
// (the "Meetings" API, scope meeting:read:list_past_participants) — NOT the
// separate /report/meetings/{id}/participants endpoint, which needs an
// admin-only report:read:list_meeting_participants:admin scope unavailable
// to a Server-to-Server app like this one. Trade-off accepted for that
// reason: this endpoint returns id/name for every attendee but only
// includes an email when Zoom is willing to disclose one (reliably true for
// the host, sometimes true for other attendees on the same account —
// external guests typically have name only, no join/leave times either).

export interface ZoomPastParticipant {
  id: string;
  name: string;
  user_email?: string;
}

interface ZoomPastParticipantsPage {
  participants: ZoomPastParticipant[];
  next_page_token?: string;
}

/** Zoom's documented gotcha: a meeting UUID that starts with `/` or contains
 * `//` must be double-encoded as a path segment, or the request 404s. Always
 * double-encoding is the standard workaround — harmless for UUIDs that
 * don't hit that edge case, since Zoom decodes twice either way. */
function encodeMeetingUuidForPath(zoomMeetingId: string): string {
  return encodeURIComponent(encodeURIComponent(zoomMeetingId));
}

/** Fetches every attendee of a past meeting occurrence, paginating until
 * exhausted. Callers should wrap this in a try/catch — a failure here (scope
 * not actually granted, meeting not found, transient error) must never block
 * capturing the transcript itself; fall back to host-only. */
export async function listPastMeetingParticipants(
  accessToken: string,
  zoomMeetingId: string
): Promise<ZoomPastParticipant[]> {
  const encodedUuid = encodeMeetingUuidForPath(zoomMeetingId);
  const participants: ZoomPastParticipant[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`https://api.zoom.us/v2/past_meetings/${encodedUuid}/participants`);
    url.searchParams.set("page_size", "300");
    if (pageToken) url.searchParams.set("next_page_token", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Zoom past-meeting participants request failed (${res.status}): ${await res.text()}`);
    }
    const page = (await res.json()) as ZoomPastParticipantsPage;
    participants.push(...(page.participants ?? []));
    pageToken = page.next_page_token || undefined;
  } while (pageToken);

  return participants;
}

// --- VTT -> plain text -------------------------------------------------------------

// Zoom's cloud-recording transcript file is WEBVTT: a "WEBVTT" header, cue
// index numbers, "start --> end" timestamp lines, and the spoken text
// (sometimes wrapped in `<v Speaker Name>...</v>`). Only the spoken text
// matters for extraction — strip everything else, and turn `<v>` tags into a
// plain "Speaker: text" line so extractInsights/extractMeetingMetadata get
// the same kind of speaker-labeled text a manual transcript paste would have.
export function parseVttToPlainText(vtt: string): string {
  const out: string[] = [];
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT") continue;
    if (/^\d+$/.test(line)) continue; // cue index
    if (line.includes("-->")) continue; // timestamp line

    const speakerMatch = line.match(/^<v\s+([^>]+)>(.*?)(<\/v>)?$/);
    out.push(speakerMatch ? `${speakerMatch[1].trim()}: ${speakerMatch[2].trim()}` : line);
  }
  return out.join("\n");
}

// --- webhook signature verification -------------------------------------------------

// Verifies against the RAW request body string — Fastify's re-parsed JSON
// object is not guaranteed to re-serialize to the exact bytes Zoom signed
// (key order, whitespace), so app.ts's custom content-type parser stashes
// the raw string on the request specifically so this can check it.
export function verifyZoomWebhookSignature(input: { rawBody: string; timestamp: string; signature: string }): boolean {
  const secret = requireEnv("ZOOM_WEBHOOK_SECRET_TOKEN");
  const message = `v0:${input.timestamp}:${input.rawBody}`;
  const expected = `v0=${createHmac("sha256", secret).update(message).digest("hex")}`;

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(input.signature);
  // Length check before timingSafeEqual — it throws on mismatched lengths
  // rather than returning false.
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/** Per Zoom's own recommendation — reject a signature check for a request
 * whose timestamp is stale, even if the signature itself would otherwise
 * check out (e.g. a replayed request). */
export function isTimestampFresh(timestamp: string, maxAgeMs = 5 * 60 * 1000): boolean {
  const ts = Number(timestamp);
  return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= maxAgeMs;
}

/** Handles Zoom's one-time "endpoint.url_validation" handshake, sent when a
 * webhook subscription's URL is saved/validated in the Marketplace UI. */
export function buildUrlValidationResponse(plainToken: string): { plainToken: string; encryptedToken: string } {
  const secret = requireEnv("ZOOM_WEBHOOK_SECRET_TOKEN");
  const encryptedToken = createHmac("sha256", secret).update(plainToken).digest("hex");
  return { plainToken, encryptedToken };
}

// --- webhook payload shape (only the fields this app actually reads) ---------------

export interface ZoomRecordingFile {
  file_type: string;
  download_url: string;
}

export interface ZoomRecordingObject {
  /** Per-occurrence identifier — NOT `id`, which is reused across every
   * occurrence of a recurring meeting. This is what meetings.zoomMeetingId stores. */
  uuid: string;
  topic?: string;
  start_time?: string;
  /** Minutes. */
  duration?: number;
  host_email?: string;
  recording_files?: ZoomRecordingFile[];
}

export interface ZoomWebhookEnvelope {
  event: string;
  payload?: {
    /** Only present for event: "endpoint.url_validation". */
    plainToken?: string;
    object?: ZoomRecordingObject;
  };
}
