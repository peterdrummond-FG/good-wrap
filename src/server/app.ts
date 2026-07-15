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
import { getMeetingDetail, listFollowUps, listMeetings } from "./queries";
import { captureManualMeeting, type CaptureManualMeetingInput } from "../ingest/captureManualMeeting";
import { runFullPipeline } from "../pipeline/runFullPipeline";
import { askQuestion } from "../qa/askQuestion";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true });

  app.get("/api/meetings", async (_req, reply) => {
    const meetings = await listMeetings();
    return reply.send({ meetings });
  });

  app.get("/api/followups", async (_req, reply) => {
    const followUps = await listFollowUps();
    return reply.send({ followUps });
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

  app.post<{ Params: { id: string } }>("/api/meetings/:id/process", async (req, reply) => {
    try {
      const result = await runFullPipeline(req.params.id);
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
