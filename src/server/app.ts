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
  getMeetingDetail,
  listActionItems,
  listFollowUps,
  listMeetings,
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
    let result;
    try {
      result = await captureManualMeeting(req.body);
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

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
      try {
        const found = await updateMeeting(req.params.id, req.body ?? {});
        if (!found) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      } catch (err) {
        req.log.error(err);
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
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
      try {
        const { found } = await updateMeetingInsights(req.params.id, req.body ?? {});
        if (!found) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ meeting });
      } catch (err) {
        req.log.error(err);
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
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
      try {
        const result = await submitMeetingReview(req.params.id, req.body);
        if (!result) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        const meeting = await getMeetingDetail(req.params.id);
        return reply.send({ ...result, meeting });
      } catch (err) {
        req.log.error(err);
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/api/meetings/:id", async (req, reply) => {
    try {
      const found = await deleteMeeting(req.params.id);
      if (!found) {
        return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
      }
      return reply.code(204).send();
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
      try {
        const meeting = await regenerateInsightCategory(req.params.id, category);
        if (!meeting) {
          return reply.code(404).send({ error: `No meeting found for id ${req.params.id}` });
        }
        return reply.send({ meeting });
      } catch (err) {
        req.log.error(err);
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.post<{ Params: { id: string } }>("/api/meetings/:id/process", async (req, reply) => {
    try {
      // Lower embedding batch size for this manual reprocess path only —
      // this route is what the dashboard's "Reprocess meeting" button calls
      // (capture-time auto-processing goes through a separate call site
      // below, and keeps the default batch size). Needed because the
      // backend runs on a memory-capped Railway plan that OOM-killed the
      // container at the default batch size of 32 during a real reprocess.
      const result = await runFullPipeline(req.params.id, { embedBatchSize: 8 });
      return reply.send(result);
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Body: { question?: string } }>("/api/ask", async (req, reply) => {
    const question = req.body?.question?.trim();
    if (!question) {
      return reply.code(400).send({ error: "question is required" });
    }
    try {
      const result = await askQuestion(question);
      return reply.send(result);
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}
