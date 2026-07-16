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
import {
  deleteMeeting,
  getCurrentUser,
  getMeetingDetail,
  getPersonDetail,
  listActionItems,
  listFollowUps,
  listMeetings,
  listPeople,
  sendActionItemToAsana,
  updateMeeting,
  updateMeetingInsights,
  type UpdateMeetingInput,
  type UpdateMeetingInsightsInput,
} from "./queries";
import { captureManualMeeting, type CaptureManualMeetingInput } from "../ingest/captureManualMeeting";
import { runFullPipeline } from "../pipeline/runFullPipeline";
import { submitMeetingReview, type ReviewMeetingInput } from "../pipeline/reviewMeeting";
import { regenerateInsightCategory, type RegenerateCategory } from "../pipeline/regenerateCategory";
import { askQuestion } from "../qa/askQuestion";
import { summarizePersonHistory } from "../qa/personSummary";

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
    // is the same code path Stage 6's Zoom webhook will hit later, so wiring
    // it here now means nothing changes there when that lands.
    //
    // Deliberately a separate try/catch from the capture above: the meeting
    // is already safely written to the DB at this point, so a processing
    // failure (e.g. a flaky Claude API call) shouldn't be reported as if the
    // whole capture failed. The dashboard still has the "Reprocess meeting"
    // button in MeetingDetail.vue for this case.
    try {
      await runFullPipeline(result.meetingId);
      return reply.code(201).send({ ...result, processed: true });
    } catch (err) {
      req.log.error(err, "Auto-processing failed after capture");
      return reply.code(201).send({
        ...result,
        processed: false,
        processingError: err instanceof Error ? err.message : String(err),
      });
    }
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
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
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

  // Triggers a real Claude call — never run automatically, only from the
  // person page's explicit "Generate summary" button.
  app.post<{ Params: { id: string } }>("/api/people/:id/summary", async (req, reply) => {
    const result = await summarizePersonHistory(req.params.id);
    if (!result) {
      return reply.code(404).send({ error: `No person found for id ${req.params.id}` });
    }
    return reply.send(result);
  });

  return app;
}
