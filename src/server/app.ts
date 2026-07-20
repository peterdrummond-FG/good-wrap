// Stage 4 API — now backing the real, permanent dashboard (not a throwaway
// POC — see Account-screen onboarding work, 2026-07-20). Real per-user auth
// lives in ./auth (requireAuth/requireAdmin); this file wires it onto route
// groups and keeps the actual business logic in queries.ts,
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
  getMeetingDetail,
  getPersonDetail,
  isMeetingOwnedBy,
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
import { requireAuth, requireAdmin } from "./auth";
import { registerIntegrationsRoutes, registerIntegrationCallbackRoute } from "./routes/integrations";
import { registerWorkerKeyRoutes } from "./routes/workerKeys";
import { registerAdminRoutes } from "./routes/admin";

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
  // #8 — was origin: true, reflecting any request's Origin header). Real
  // per-route auth landed 2026-07-20 (see ./auth), but this allow-list stays
  // as defense in depth regardless.
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

  // Zoom webhook — automatic capture path, own HMAC auth (Zoom's own
  // recommended verification), never requireAuth. Registered directly on the
  // root app so no preHandler hook below ever applies to it. See
  // .env.example for the required ZOOM_* env vars and
  // captureFromZoomWebhook.ts for the downstream orchestration.
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

  // OAuth callback for Zoom/Asana "Connect account" — the provider's own
  // top-level browser redirect, carrying no bearer token. Authenticates via
  // the signed `state` param instead (see src/util/oauthState.ts), so this
  // also stays outside the requireAuth-hooked scope below.
  registerIntegrationCallbackRoute(app);

  // Everything else needs a resolved identity — a signed-in dashboard user
  // (Supabase JWT) or a valid personal worker key (x-worker-key), see
  // ./auth's requireAuth. Every route below can assume req.currentUser is set.
  app.register(async (instance) => {
    instance.addHook("preHandler", requireAuth);

    instance.get("/api/me", async (req, reply) => {
      return reply.send({ user: req.currentUser });
    });

    instance.get("/api/meetings", async (req, reply) => {
      const meetings = await listMeetings(req.currentUser!.id);
      return reply.send({ meetings });
    });

    // Known companies (including "Flippen Group" itself) — shared team
    // directory data, not scoped per-user. Powers the meeting detail page's
    // tag picker. See db/schema.ts's companies comment.
    instance.get("/api/companies", async (_req, reply) => {
      const companies = await listCompanies();
      return reply.send({ companies });
    });

    instance.get("/api/followups", async (req, reply) => {
      // Both lists are approved-only (see queries.ts) — unapproved suggestions
      // only ever surface on the meeting detail page's review UI.
      const ownerId = req.currentUser!.id;
      const [followUps, actionItems] = await Promise.all([listFollowUps(ownerId), listActionItems(ownerId)]);
      return reply.send({ followUps, actionItems });
    });

    instance.get<{ Params: { id: string } }>("/api/meetings/:id", async (req, reply) => {
      if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      const meeting = await getMeetingDetail(req.params.id);
      return reply.send({ meeting });
    });

    instance.post<{ Body: CaptureManualMeetingInput }>("/api/meetings", async (req, reply) => {
      const result = await captureManualMeeting({ ...req.body, ownerEmail: req.currentUser!.email });

      // Auto-process right after capture — a meeting shouldn't need a manual
      // "Process this meeting" click before it's useful, and this is the
      // same code path the Zoom webhook and file-upload capture below also
      // use (see autoProcess above).
      const outcome = await autoProcess(result.meetingId, (err) =>
        req.log.error(err, "Auto-processing failed after capture")
      );
      return reply.code(201).send({ ...result, ...outcome });
    });

    // File-upload capture (the "upload a transcript" flow) — a single .txt
    // file with NO structured metadata attached, unlike the JSON route above.
    // resolveCaptureContent parses topic/date/duration/participants/transcript
    // deterministically when the file matches the fixed export format
    // (parseStructuredTranscript.ts), falling back to Claude-based inference
    // (extractMeetingMetadata.ts) only for freeform text that doesn't. Capture
    // + auto-process then proceed exactly as the JSON route above. Saves and
    // processes immediately (no separate review-before-save step), matching
    // how manual capture already behaves — the resolved metadata is returned
    // alongside the result so a bad guess is visible right away.
    instance.post("/api/meetings/upload", async (req, reply) => {
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
        ownerEmail: req.currentUser!.email,
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
    // the connecting user's own Claude Code plan/session usage, not
    // ANTHROPIC_API_KEY) generates the 4 insight categories itself instead of
    // scanFolder.ts calling extractInsights() — see src/ingest/scanFolder.ts
    // and .claude/skills/process-transcripts/SKILL.md. This route relies
    // entirely on requireAuth's x-worker-key handling (see ./auth) to
    // resolve WHICH user this upload belongs to — req.currentUser here is
    // whichever person's personal worker key was sent (or, during rollout,
    // whoever DEFAULT_OWNER_EMAIL points at if the legacy shared secret was
    // sent instead — see auth.ts's resolveFromWorkerKey).
    instance.post<{
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
        ownerEmail: req.currentUser!.email,
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

    instance.patch<{ Params: { id: string }; Body: UpdateMeetingInput }>(
      "/api/meetings/:id",
      async (req, reply) => {
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        await updateMeeting(req.params.id, req.body ?? {});
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      }
    );

    // Manual re-tag/correction — always wins over Claude's own guess from here
    // on (see setMeetingCompany/applyAiCompanyGuess in queries.ts). Pass
    // companyId: null to clear the tag entirely (still counts as a manual
    // decision, so a later reprocess won't silently re-tag it).
    instance.patch<{ Params: { id: string }; Body: { companyId: string | null } }>(
      "/api/meetings/:id/company",
      async (req, reply) => {
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        await setMeetingCompany(req.params.id, req.body?.companyId ?? null);
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      }
    );

    // Generic insights edit — no notification side effects, doesn't touch
    // either reviewed-at column. Used for e.g. fixing a keyword typo. The
    // meeting detail page's review flow (picking/approving suggestions) goes
    // through POST /api/meetings/:id/review below instead, since that action
    // needs to gate notifications.
    instance.patch<{ Params: { id: string }; Body: UpdateMeetingInsightsInput }>(
      "/api/meetings/:id/insights",
      async (req, reply) => {
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        await updateMeetingInsights(req.params.id, req.body ?? {});
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      }
    );

    // Submit a review: persists ONE category's approved selections (Action
    // Items or Follow-ups — see ReviewMeetingInput), and — the first time
    // THAT category's own reviewed-at moves from null to set — fires the
    // email/chat notifications with whatever's currently approved. See
    // src/pipeline/reviewMeeting.ts for the per-category gating logic.
    instance.post<{ Params: { id: string }; Body: ReviewMeetingInput }>(
      "/api/meetings/:id/review",
      async (req, reply) => {
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        const result = await submitMeetingReview(req.params.id, req.body);
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ ...result, meeting });
      }
    );

    instance.delete<{ Params: { id: string } }>("/api/meetings/:id", async (req, reply) => {
      if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      await deleteMeeting(req.params.id);
      return reply.code(204).send();
    });

    // Regenerates ONE category (takeaways/actionItems/followUps) via a fresh
    // Claude call, triggered by the pencil icon on that category's review
    // column. See regenerateCategory.ts — never fires notifications, and
    // leaves the other two categories untouched (though it does reset that
    // one category's own reviewed-at back to null for actionItems/followUps).
    instance.post<{ Params: { id: string }; Body: { category?: RegenerateCategory } }>(
      "/api/meetings/:id/regenerate",
      async (req, reply) => {
        const category = req.body?.category;
        if (category !== "takeaways" && category !== "actionItems" && category !== "followUps") {
          return reply
            .code(400)
            .send({ error: `category must be one of takeaways/actionItems/followUps, got: ${category}` });
        }
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        const meeting = await regenerateInsightCategory(req.params.id, category);
        return reply.send({ meeting });
      }
    );

    // Pushes one approved Action Item to Asana (manual "Send to Asana" button
    // on the meeting detail page — Action Items only, never Follow-ups, see
    // src/integrations/asana.ts). Re-calling for an already-sent item is a
    // no-op (returns the existing task instead of creating a duplicate). Uses
    // the acting user's own connected Asana account when they have one (see
    // queries.ts's sendActionItemToAsana), so the task is attributed to them.
    instance.post<{ Params: { id: string; index: string } }>(
      "/api/meetings/:id/action-items/:index/send-to-asana",
      async (req, reply) => {
        const index = parseIndexParam(req.params.index);
        if (index === null) {
          return reply
            .code(400)
            .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
        }
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        const result = await sendActionItemToAsana(req.params.id, index, req.currentUser!.id);
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
    instance.post<{ Params: { id: string; index: string }; Body: { done?: boolean } }>(
      "/api/meetings/:id/action-items/:index/done",
      async (req, reply) => {
        const index = parseIndexParam(req.params.index);
        if (index === null) {
          return reply
            .code(400)
            .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
        }
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        await setActionItemDone(req.params.id, index, Boolean(req.body?.done));
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      }
    );

    // Permanently removes one Action Item — not just unapproving it.
    instance.delete<{ Params: { id: string; index: string } }>(
      "/api/meetings/:id/action-items/:index",
      async (req, reply) => {
        const index = parseIndexParam(req.params.index);
        if (index === null) {
          return reply
            .code(400)
            .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
        }
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        await deleteActionItem(req.params.id, index);
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      }
    );

    // Same as the two Action Item routes above, for Follow-ups (no Asana push
    // here — Follow-ups are explicitly other people's tasks, never the
    // owner's).
    instance.post<{ Params: { id: string; index: string }; Body: { done?: boolean } }>(
      "/api/meetings/:id/follow-ups/:index/done",
      async (req, reply) => {
        const index = parseIndexParam(req.params.index);
        if (index === null) {
          return reply
            .code(400)
            .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
        }
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        await setFollowUpDone(req.params.id, index, Boolean(req.body?.done));
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      }
    );

    instance.delete<{ Params: { id: string; index: string } }>(
      "/api/meetings/:id/follow-ups/:index",
      async (req, reply) => {
        const index = parseIndexParam(req.params.index);
        if (index === null) {
          return reply
            .code(400)
            .send({ error: `index must be a non-negative integer, got: ${req.params.index}` });
        }
        if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        await deleteFollowUp(req.params.id, index);
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      }
    );

    instance.post<{ Params: { id: string } }>("/api/meetings/:id/process", async (req, reply) => {
      if (!(await isMeetingOwnedBy(req.params.id, req.currentUser!.id))) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      // Lower embedding batch size for this manual reprocess path only — this
      // route is what the dashboard's "Reprocess meeting" button calls
      // (capture-time auto-processing goes through a separate call site above,
      // and keeps the default batch size). Needed because the backend runs on
      // a memory-capped Railway plan that OOM-killed the container at the
      // default batch size of 32 during a real reprocess.
      const result = await runFullPipeline(req.params.id, { embedBatchSize: 8 });
      return reply.send(result);
    });

    // Not scoped per-user (searches across ALL transcripts globally) — a
    // known, deliberate limitation of this pass, not an oversight. Genuinely
    // scoping semantic search would also require scoping transcript_chunks by
    // owner, a deeper change than the meeting-list/detail routes above.
    instance.post<{ Body: { question?: string } }>("/api/ask", async (req, reply) => {
      const question = req.body?.question?.trim();
      if (!question) {
        return reply.code(400).send({ error: "question is required" });
      }
      const result = await askQuestion(question);
      return reply.send(result);
    });

    // Manual "Person" page (#9) — on-demand meeting prep, no calendar
    // integration. Shared team directory data, not scoped per-user. See
    // queries.ts's listPeople/getPersonDetail and qa/personSummary.ts.
    instance.get("/api/people", async (_req, reply) => {
      const people = await listPeople();
      return reply.send({ people });
    });

    instance.get<{ Params: { id: string } }>("/api/people/:id", async (req, reply) => {
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
    instance.patch<{ Params: { id: string }; Body: { companyIds?: string[] } }>(
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
    instance.post<{ Params: { id: string } }>("/api/people/:id/summary", async (req, reply) => {
      const result = await summarizePersonHistory(req.params.id);
      if (!result) {
        return reply.code(404).send({ error: `No person found for id ${req.params.id}` });
      }
      return reply.send(result);
    });

    // Per-user "Connect Zoom / Connect Asana" OAuth + personal worker keys —
    // powers the Account page (see routes/integrations.ts, routes/workerKeys.ts).
    registerIntegrationsRoutes(instance);
    registerWorkerKeyRoutes(instance);

    // Admin-only: inviting teammates, offboarding (see routes/admin.ts).
    instance.register(async (adminInstance) => {
      adminInstance.addHook("preHandler", requireAdmin);
      registerAdminRoutes(adminInstance);
    });
  });

  return app;
}
