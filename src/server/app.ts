// Stage 4: minimal API backing the temporary standalone dashboard.
//
// This is deliberately throwaway plumbing: a small Fastify server with no
// auth, meant to run locally next to the Quasar dev server while Peter looks
// at a proof of concept. When this gets rewritten to live inside the actual
// hub app (per Peter's plan), the hub's own backend conventions and auth
// replace this file entirely — the real logic lives in queries.ts,
// captureManualMeeting.ts, processMeeting.ts, etc., which this just exposes
// over HTTP.

import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  applyAiCompanyGuess,
  deleteActionItem,
  deleteFollowUp,
  deleteMeeting,
  findMeetingBySourceKey,
  getCurrentUser,
  getMeetingDetail,
  getPersonDetail,
  listActionItems,
  listCompanies,
  listFollowUps,
  listMeetings,
  listPeople,
  sendActionItemToAsana,
  setActionItemDone,
  setFollowUpDone,
  setMeetingCompany,
  setPersonCompanies,
  updateMeeting,
  updateMeetingInsights,
  type UpdateMeetingInput,
  type UpdateMeetingInsightsInput,
} from "./queries";
import {
  captureManualMeeting,
  type CaptureManualMeetingInput,
  type CaptureParticipantInput,
} from "../ingest/captureManualMeeting";
import { resolveCaptureContent } from "../ingest/resolveCaptureContent";
import { handleZoomTranscriptEvent } from "../ingest/captureFromZoomWebhook";
import { validateProcessedInsights, type ProcessedInsightsInput } from "../ingest/validateProcessedInsights";
import { runFullPipeline } from "../pipeline/runFullPipeline";
import { persistMeetingInsights } from "../pipeline/persistMeetingInsights";
import { submitMeetingReview, type ReviewMeetingInput } from "../pipeline/reviewMeeting";
import { regenerateInsightCategory, type RegenerateCategory } from "../pipeline/regenerateCategory";
import { askQuestion } from "../qa/askQuestion";
import { summarizePersonHistory } from "../qa/personSummary";
import {
  verifyZoomWebhookSignature,
  isTimestampFresh,
  buildUrlValidationResponse,
  type ZoomWebhookEnvelope,
} from "../integrations/zoom";

// Fastify's default JSON parser only exposes the re-parsed object, not the
// original bytes — augmented here so the Zoom webhook route (the one place
// that needs it) can verify Zoom's HMAC signature against the exact string
// Zoom signed, not a re-serialization of it that could differ in key order
// or whitespace.
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

// Shared by every action-items/:index and follow-ups/:index route below —
// `index` addresses an item by its position in the meeting's own array (see
// queries.ts's loadMeetingInsightsRow comment). Returns null on anything
// that isn't a non-negative integer, so callers can 400 uniformly.
function parseIndexParam(raw: string): number | null {
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

// Shared by every capture route (JSON form, file upload) — a meeting is
// already safely written to the DB by the time this runs, so a processing
// failure (e.g. a flaky Claude API call) is reported alongside a successful
// capture rather than as a failure of the capture itself. Always resolves,
// never throws — the dashboard's "Reprocess meeting" button covers retrying.
async function autoProcess(
  meetingId: string,
  logError: (err: unknown) => void
): Promise<{ processed: boolean; processingError?: string }> {
  try {
    await runFullPipeline(meetingId);
    return { processed: true };
  } catch (err) {
    logError(err);
    return { processed: false, processingError: err instanceof Error ? err.message : String(err) };
  }
}

export function buildApp() {
  const app = Fastify({ logger: true });

  // Locked to an explicit allow-list (changed 2026-07-15, CODE-AUDIT.md item
  // #8 — was origin: true, reflecting any request's Origin header, which
  // combined with zero auth on every route below meant any website a browser
  // visited could call this API). Still no auth, so this list is the only
  // thing standing between the API and the open internet — keep it to
  // exactly the origins that legitimately call it.
  //
  // Extended 2026-07-16 for the Vercel/Railway deploy: the dashboard now
  // also runs at good-wrap.vercel.app (Railway hosts the API itself, so it's
  // never the *origin* of a browser request and doesn't need to be listed
  // here). ALLOWED_ORIGINS is an optional comma-separated env var so a new
  // Vercel preview-deployment URL can be added on Railway without a code
  // change/redeploy; the defaults below cover local dev + the known
  // production Vercel domain.
  const defaultOrigins = ["http://localhost:5173", "https://good-wrap.vercel.app"];
  const extraOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.register(cors, { origin: [...defaultOrigins, ...extraOrigins] });

  // File-upload capture (see POST /api/meetings/upload below). Capped well
  // above any real transcript's size but still bounded — this feeds straight
  // into in-memory Claude extraction and chunking/embedding downstream.
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

  // Replaces Fastify's default application/json parser so every request
  // also gets its exact raw body stashed on req.rawBody (see the
  // `declare module "fastify"` augmentation above) — needed only by the
  // Zoom webhook route's signature check below, but registered globally
  // since Fastify doesn't support a per-route content-type parser. Parsing
  // behavior for every other JSON route is unchanged.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body.length ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Every route below threw its own error straight to a per-route try/catch
  // that logged it and replied 400 with the error's message — identical
  // boilerplate repeated at every call site. Centralized here: a route
  // handler can now just throw (or let an awaited call reject) and this
  // catches it uniformly. Explicit reply.code(404)/(400) calls for expected
  // "not found"/"bad input" cases are unaffected — those return directly and
  // never reach this handler.
  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  });

  // Added 2026-07-16 — not auth (this stays a no-auth personal POC), just a
  // way to make the existing implicit "current user" assumption
  // (DEFAULT_OWNER_EMAIL, see queries.ts's getCurrentUser) visible in the UI
  // instead of buried in an env var nothing ever surfaces. Lets the
  // dashboard show "Signed in as X" and gives any future feature that needs
  // "who is the user" one place to ask, rather than re-reading the env var
  // directly and risking drift the way Claude extraction once did.
  app.get("/api/me", async (_req, reply) => {
    const user = await getCurrentUser();
    if (!user) {
      return reply.code(404).send({ error: "No current user — DEFAULT_OWNER_EMAIL is unset or invalid." });
    }
    return reply.send({ user });
  });

  app.get("/api/meetings", async (_req, reply) => {
    const meetings = await listMeetings();
    return reply.send({ meetings });
  });

  // Known companies (including "Flippen Group" itself) — powers the meeting
  // detail page's tag picker. See db/schema.ts's companies comment.
  app.get("/api/companies", async (_req, reply) => {
    const companies = await listCompanies();
    return reply.send({ companies });
  });

  app.get("/api/followups", async (_req, reply) => {
    // Both lists are approved-only (see queries.ts) — unapproved suggestions
    // only ever surface on the meeting detail page's review UI.
    const [followUps, actionItems] = await Promise.all([listFollowUps(), listActionItems()]);
    return reply.send({ followUps, actionItems });
  });

  app.get<{ Params: { id: string } }>("/api/meetings/:id", async (req, reply) => {
    const meeting = await getMeetingDetail(req.params.id);
    if (!meeting) {
      return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
    }
    return reply.send({ meeting });
  });

  app.post<{ Body: CaptureManualMeetingInput }>("/api/meetings", async (req, reply) => {
    const result = await captureManualMeeting(req.body);

    // Auto-process right after capture — Peter's call: a meeting shouldn't
    // need a manual "Process this meeting" click before it's useful, and this
    // is the same code path the Zoom webhook and file-upload capture below
    // also use (see autoProcess above).
    const outcome = await autoProcess(result.meetingId, (err) =>
      req.log.error(err, "Auto-processing failed after capture")
    );
    return reply.code(201).send({ ...result, ...outcome });
  });

  // File-upload capture (Peter's "upload a transcript" flow) — a single .txt
  // file with NO structured metadata attached, unlike the JSON route above.
  // resolveCaptureContent parses topic/date/duration/participants/transcript
  // deterministically when the file matches Peter's fixed export format
  // (parseStructuredTranscript.ts), falling back to Claude-based inference
  // (extractMeetingMetadata.ts) only for freeform text that doesn't. Capture
  // + auto-process then proceed exactly as the JSON route above. Saves and
  // processes immediately (no separate review-before-save step), matching
  // how manual capture already behaves — the resolved metadata is returned
  // alongside the result so a bad guess is visible right away.
  app.post("/api/meetings/upload", async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "No file uploaded — expected a single .txt transcript file." });
    }

    const rawText = (await file.toBuffer()).toString("utf-8");
    if (!rawText.trim()) {
      return reply.code(400).send({ error: "Uploaded file is empty." });
    }

    const fallbackTopic = file.filename.replace(/\.[^./]+$/, "").trim() || "Uploaded meeting";
    const metadata = await resolveCaptureContent({
      rawText,
      fallbackTopic,
      fallbackStartTime: new Date(),
    });

    const result = await captureManualMeeting({
      topic: metadata.topic,
      startTime: metadata.startTime,
      durationMinutes: metadata.durationMinutes,
      participants: metadata.participants,
      transcript: metadata.transcript,
      source: "upload",
    });

    const outcome = await autoProcess(result.meetingId, (err) =>
      req.log.error(err, "Auto-processing failed after upload capture")
    );
    // `transcript` omitted from the returned metadata — the dashboard only
    // needs topic/startTime/durationMinutes/participants to show what was
    // inferred/parsed, and it'd otherwise duplicate the whole stored
    // transcript in the response body.
    const { transcript: _transcript, ...visibleMetadata } = metadata;
    return reply.code(201).send({ ...result, metadata: visibleMetadata, ...outcome });
  });

  // Folder-scan capture, now that a local Claude Code session (billed to
  // Peter's Claude Code plan/session usage, not ANTHROPIC_API_KEY) generates
  // the 4 insight categories itself instead of scanFolder.ts calling
  // extractInsights() — see src/ingest/scanFolder.ts and
  // .claude/skills/process-transcripts/SKILL.md. This is the one route that
  // writes fully-formed insights straight to meeting_insights with no
  // schema-enforced Claude tool-use call in between, so it's the one route
  // on this otherwise-open API that checks a shared secret.
  app.post<{
    Body: {
      topic?: string;
      startTime?: string;
      durationMinutes?: number;
      participants?: CaptureParticipantInput[];
      transcript?: string;
      insights?: ProcessedInsightsInput;
      sourceKey?: string;
    };
  }>("/api/meetings/upload-processed", async (req, reply) => {
    const expectedKey = process.env.LOCAL_WORKER_API_KEY;
    const providedKey = req.headers["x-worker-key"];
    if (!expectedKey || providedKey !== expectedKey) {
      return reply.code(401).send({ error: "Missing or invalid x-worker-key header." });
    }

    const body = req.body ?? {};
    if (!body.topic || !body.startTime || !body.transcript || !body.insights) {
      return reply
        .code(400)
        .send({ error: "topic, startTime, transcript, and insights are all required." });
    }

    // Dedup check (added 2026-07-20, folder-scan reliability pass) — if the
    // scripted caller (scanFolder.ts's cmdClaim) already computed a
    // sourceKey and this exact transcript was already captured by an earlier
    // attempt (e.g. a retried upload after the scripted process died between
    // capturing and its own `finish` bookkeeping), return the existing
    // meeting as a no-op instead of creating a duplicate. See
    // findMeetingBySourceKey in queries.ts.
    if (body.sourceKey) {
      const existing = await findMeetingBySourceKey(body.sourceKey);
      if (existing) {
        const meeting = await getMeetingDetail(existing.id);
        return reply.code(200).send({ meetingId: existing.id, alreadyCaptured: true, meeting });
      }
    }

    const insights = validateProcessedInsights(body.insights);

    const result = await captureManualMeeting({
      topic: body.topic,
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      participants: body.participants ?? [],
      transcript: body.transcript,
      source: "upload",
      sourceKey: body.sourceKey,
    });

    // Lower embedding batch size, same fix and same reason as the
    // "Reprocess meeting" route below: this backend runs on a
    // memory-capped Railway plan that OOM-killed the container at the
    // default batch size of 32 on a real (~36KB) transcript (hit live
    // 2026-07-17 testing this route against a real folder-scan transcript).
    // Folder-scan transcripts are full meeting recordings, the same class
    // of content as a manual reprocess, so the same mitigation applies.
    const { insightsId, chunkCount } = await persistMeetingInsights(
      result.meetingId,
      result.transcriptId,
      body.transcript,
      insights,
      { embedBatchSize: 8 }
    );
    // A fresh capture never has a manual company tag yet, so this always
    // applies — see applyAiCompanyGuess's "manual always wins" guard.
    await applyAiCompanyGuess(result.meetingId, insights.companySlug);

    const meeting = await getMeetingDetail(result.meetingId);
    return reply.code(201).send({ ...result, insightsId, chunkCount, meeting });
  });

  app.patch<{ Params: { id: string }; Body: UpdateMeetingInput }>(
    "/api/meetings/:id",
    async (req, reply) => {
      const found = await updateMeeting(req.params.id, req.body ?? {});
      if (!found) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    }
  );

  // Manual re-tag/correction — always wins over Claude's own guess from here
  // on (see setMeetingCompany/applyAiCompanyGuess in queries.ts). Pass
  // companyId: null to clear the tag entirely (still counts as a manual
  // decision, so a later reprocess won't silently re-tag it).
  app.patch<{ Params: { id: string }; Body: { companyId: string | null } }>(
    "/api/meetings/:id/company",
    async (req, reply) => {
      const found = await setMeetingCompany(req.params.id, req.body?.companyId ?? null);
      if (!found) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    }
  );

  // Generic insights edit — no notification side effects, doesn't touch
  // either reviewed-at column. Used for e.g. fixing a keyword typo. The
  // meeting detail page's review flow (picking/approving suggestions) goes
  // through POST /api/meetings/:id/review below instead, since that action
  // needs to gate notifications.
  app.patch<{ Params: { id: string }; Body: UpdateMeetingInsightsInput }>(
    "/api/meetings/:id/insights",
    async (req, reply) => {
      const { found } = await updateMeetingInsights(req.params.id, req.body ?? {});
      if (!found) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    }
  );

  // Submit a review: persists ONE category's approved selections (Action
  // Items or Follow-ups — see ReviewMeetingInput), and — the first time
  // THAT category's own reviewed-at moves from null to set — fires the
  // email/chat notifications with whatever's currently approved. See
  // src/pipeline/reviewMeeting.ts for the per-category gating logic.
  app.post<{ Params: { id: string }; Body: ReviewMeetingInput }>(
    "/api/meetings/:id/review",
    async (req, reply) => {
      const result = await submitMeetingReview(req.params.id, req.body);
      if (!result) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ ...result, meeting });
    }
  );

  app.delete<{ Params: { id: string } }>("/api/meetings/:id", async (req, reply) => {
    const found = await deleteMeeting(req.params.id);
    if (!found) {
      return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
    }
    return reply.code(204).send();
  });

  // Regenerates ONE category (takeaways/actionItems/followUps) via a fresh
  // Claude call, triggered by the pencil icon on that category's review
  // column. See regenerateCategory.ts — never fires notifications, and
  // leaves the other two categories untouched (though it does reset that
  // one category's own reviewed-at back to null for actionItems/followUps).
  app.post<{ Params: { id: string }; Body: { category?: RegenerateCategory } }>(
    "/api/meetings/:id/regenerate",
    async (req, reply) => {
      const category = req.body?.category;
      if (category !== "takeaways" && category !== "actionItems" && category !== "followUps") {
        return reply
          .code(400)
          .send({ error: `category must be one of takeaways/actionItems/followUps, got: ${category}` });
      }
      const meeting = await regenerateInsightCategory(req.params.id, category);
      if (!meeting) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      return reply.send({ meeting });
    }
  );

  // Pushes one approved Action Item to Asana (manual "Send to Asana" button
  // on the meeting detail page — Action Items only, never Follow-ups, see
  // src/integrations/asana.ts). Re-calling for an already-sent item is a
  // no-op (returns the existing task instead of creating a duplicate).
  app.post<{ Params: { id: string; index: string } }>(
    "/api/meetings/:id/action-items/:index/send-to-asana",
    async (req, reply) => {
      const index = parseIndexParam(req.params.index);
      if (index === null) {
        return reply
          .code(400)
          .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
      }
      const result = await sendActionItemToAsana(req.params.id, index);
      if (!result) {
        return reply
          .code(404)
          .send({ error: `No action item found at index ${index} for meeting ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ ...result, meeting });
    }
  );

  // Toggles one Action Item's done state (greys it out in the UI, doesn't
  // remove it — see db/schema.ts's ActionItem.done comment).
  app.post<{ Params: { id: string; index: string }; Body: { done?: boolean } }>(
    "/api/meetings/:id/action-items/:index/done",
    async (req, reply) => {
      const index = parseIndexParam(req.params.index);
      if (index === null) {
        return reply
          .code(400)
          .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
      }
      const found = await setActionItemDone(req.params.id, index, Boolean(req.body?.done));
      if (!found) {
        return reply
          .code(404)
          .send({ error: `No action item found at index ${index} for meeting ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    }
  );

  // Permanently removes one Action Item — not just unapproving it.
  app.delete<{ Params: { id: string; index: string } }>(
    "/api/meetings/:id/action-items/:index",
    async (req, reply) => {
      const index = parseIndexParam(req.params.index);
      if (index === null) {
        return reply
          .code(400)
          .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
      }
      const found = await deleteActionItem(req.params.id, index);
      if (!found) {
        return reply
          .code(404)
          .send({ error: `No action item found at index ${index} for meeting ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    }
  );

  // Same as the two Action Item routes above, for Follow-ups (no Asana push
  // here — Follow-ups are explicitly other people's tasks, never Peter's).
  app.post<{ Params: { id: string; index: string }; Body: { done?: boolean } }>(
    "/api/meetings/:id/follow-ups/:index/done",
    async (req, reply) => {
      const index = parseIndexParam(req.params.index);
      if (index === null) {
        return reply
          .code(400)
          .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
      }
      const found = await setFollowUpDone(req.params.id, index, Boolean(req.body?.done));
      if (!found) {
        return reply
          .code(404)
          .send({ error: `No follow-up found at index ${index} for meeting ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    }
  );

  app.delete<{ Params: { id: string; index: string } }>(
    "/api/meetings/:id/follow-ups/:index",
    async (req, reply) => {
      const index = parseIndexParam(req.params.index);
      if (index === null) {
        return reply
          .code(400)
          .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
      }
      const found = await deleteFollowUp(req.params.id, index);
      if (!found) {
        return reply
          .code(404)
          .send({ error: `No follow-up found at index ${index} for meeting ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    }
  );

  app.post<{ Params: { id: string } }>("/api/meetings/:id/process", async (req, reply) => {
    // Lower embedding batch size for this manual reprocess path only — this
    // route is what the dashboard's "Reprocess meeting" button calls
    // (capture-time auto-processing goes through a separate call site above,
    // and keeps the default batch size). Needed because the backend runs on
    // a memory-capped Railway plan that OOM-killed the container at the
    // default batch size of 32 during a real reprocess.
    const result = await runFullPipeline(req.params.id, { embedBatchSize: 8 });
    return reply.send(result);
  });

  app.post<{ Body: { question?: string } }>("/api/ask", async (req, reply) => {
    const question = req.body?.question?.trim();
    if (!question) {
      return reply.code(400).send({ error: "question is required" });
    }
    const result = await askQuestion(question);
    return reply.send(result);
  });

  // Manual "Person" page (#9) — on-demand meeting prep, no calendar
  // integration. See queries.ts's listPeople/getPersonDetail and
  // qa/personSummary.ts.
  app.get("/api/people", async (_req, reply) => {
    const people = await listPeople();
    return reply.send({ people });
  });

  app.get<{ Params: { id: string } }>("/api/people/:id", async (req, reply) => {
    const person = await getPersonDetail(req.params.id);
    if (!person) {
      return reply.code(404).send({ error: `No person found for id ${req.params.id}` });
    }
    return reply.send({ person });
  });

  // Sets which companies this person works with — always a direct, manual
  // pick from the person page (never inferred from their meeting history,
  // since some people work with exactly one company while Flippen Group
  // staff span several). Replaces the person's full set each call.
  app.patch<{ Params: { id: string }; Body: { companyIds?: string[] } }>(
    "/api/people/:id/companies",
    async (req, reply) => {
      const found = await setPersonCompanies(req.params.id, req.body?.companyIds ?? []);
      if (!found) {
        return reply.code(404).send({ error: `No person found for id ${req.params.id}` });
      }
      const person = await getPersonDetail(req.params.id);
      return reply.send({ person });
    }
  );

  // Triggers a real Claude call — never run automatically, only from the
  // person page's explicit "Generate summary" button.
  app.post<{ Params: { id: string } }>("/api/people/:id/summary", async (req, reply) => {
    const result = await summarizePersonHistory(req.params.id);
    if (!result) {
      return reply.code(404).send({ error: `No person found for id ${req.params.id}` });
    }
    return reply.send(result);
  });

  // Zoom webhook — automatic capture path (a), see .env.example for the
  // required ZOOM_* env vars and captureFromZoomWebhook.ts for the
  // downstream orchestration. This endpoint has no other auth, so the HMAC
  // signature check below is the only thing standing between it and the
  // open internet (Zoom's own recommended verification, not optional here).
  app.post<{ Body: ZoomWebhookEnvelope }>("/api/webhooks/zoom", async (req, reply) => {
    const body = req.body;

    // One-time handshake Zoom performs when a webhook subscription's URL is
    // saved/validated in the Marketplace UI — no signature to check yet at
    // this point, since Zoom is asking us to prove we hold the secret, not
    // the other way around.
    if (body?.event === "endpoint.url_validation") {
      const plainToken = body.payload?.plainToken;
      if (!plainToken) {
        return reply.code(400).send({ error: "Missing payload.plainToken for endpoint.url_validation." });
      }
      return reply.send(buildUrlValidationResponse(plainToken));
    }

    const signature = req.headers["x-zm-signature"];
    const timestamp = req.headers["x-zm-request-timestamp"];
    if (
      typeof signature !== "string" ||
      typeof timestamp !== "string" ||
      !isTimestampFresh(timestamp) ||
      !verifyZoomWebhookSignature({ rawBody: req.rawBody ?? "", timestamp, signature })
    ) {
      return reply.code(401).send({ error: "Invalid or stale Zoom webhook signature." });
    }

    // Ack immediately — Zoom expects a fast response and retries
    // aggressively on timeout/non-2xx, and the real work below (transcript
    // download + Claude calls) can easily take longer than it's willing to
    // wait. Everything after this point runs detached from the
    // request/reply lifecycle: its promise is deliberately never awaited or
    // returned, and its `.catch` is the ONLY place its errors are ever
    // observed — nothing here may throw back into Fastify after `send()`
    // has already been called, or the app-wide error handler would attempt
    // to reply a second time.
    reply.code(200).send({ received: true });

    if (body.event === "recording.transcript_completed") {
      void handleZoomTranscriptEvent(body).catch((err) => {
        req.log.error(err, "Zoom webhook processing failed");
      });
    }
  });

  return app;
}
