// Folder auto-scan (Peter's "drop a .txt transcript in this folder" flow).
//
// Reworked 2026-07-17: this used to be one atomic run that captured a file
// AND called extractInsights() (billed Anthropic API) in-process. That LLM
// step now happens in a local Claude Code session instead (billed to Peter's
// Claude Code plan/session usage) — see
// .claude/skills/process-transcripts/SKILL.md, which shells out to the
// subcommands below and POSTs the result to
// POST /api/meetings/upload-processed (src/server/app.ts) once it's
// generated the 4 insight categories itself. This file now only exposes the
// deterministic filesystem bookkeeping — no Claude/Anthropic import here at
// all.
//
// Subcommands (run via `npm run scan-folder -- <subcommand> ...`):
//   pull-zoom                     -> fetches any Zoom transcripts staged by
//                                     the webhook handler
//                                     (src/ingest/captureFromZoomWebhook.ts,
//                                     GET /api/zoom/pending-exports) and
//                                     writes each as a structured .txt into
//                                     the watch folder — same as if Peter had
//                                     dropped it in by hand. Confirms each
//                                     write by calling
//                                     DELETE /api/zoom/pending-exports/:id
//                                     only after the file is safely on disk,
//                                     so a crash between fetch and write
//                                     can't lose a transcript (it's just
//                                     fetched again next run). Prints
//                                     { written: [filenames] }. A failure
//                                     here (network error, missing env var)
//                                     must never prevent the subcommands
//                                     below from running — see SKILL.md.
//   list                          -> JSON array of candidate filenames
//   claim <file>                  -> claims the file (locks it), prints
//                                     { rawText, parsed, sourceKey } as JSON.
//                                     `parsed` is Peter's fixed-export
//                                     metadata (see parseStructuredTranscript.ts)
//                                     or null if the file doesn't match that
//                                     shape — the caller (a Claude Code
//                                     session) reads rawText itself to infer
//                                     metadata in that case, with no Claude
//                                     API call. `sourceKey` is a
//                                     `sha256:<hex>` idempotency key over
//                                     rawText — carry it through unchanged
//                                     into the upload-processed payload (see
//                                     app.ts's dedup check).
//   finish <file> processed|failed [--date "<ISO>"] [--error "<message>"]
//                                 -> moves the claimed file to its final
//                                     resting place. For `processed`,
//                                     `--date` (the meeting's own startTime)
//                                     buckets the destination into
//                                     processed/<year>/week-<NN>/ (see
//                                     computeWeekBucket in
//                                     src/util/weekBucket.ts) — falls back to
//                                     the locked file's own mtime if omitted.
//                                     `failed` stays flat, deliberately (see
//                                     below).
//   reconcile                     -> un-claims any .processing/ file whose
//                                     claim has gone stale (the run that
//                                     claimed it died before calling finish —
//                                     a Claude usage session-limit hit or a
//                                     network drop, both observed in
//                                     practice) by moving it back to the
//                                     top-level watch dir, so the next `list`
//                                     picks it up as a fresh candidate. Safe
//                                     to retry even if the dead run's upload
//                                     had actually already succeeded — the
//                                     sourceKey dedup check in app.ts turns a
//                                     re-upload into a no-op instead of a
//                                     duplicate meeting. Also reports how
//                                     many files are sitting in failed/, so
//                                     those aren't silently invisible. Prints
//                                     { unclaimed: [{filename, staleForMs}],
//                                     failedCount }.
//
// Directory layout (unchanged from before):
//   <watch dir>/*.txt         -> candidates
//   <watch dir>/.processing/  -> claimed by an in-progress run (lock)
//   <watch dir>/processed/    -> captured successfully, bucketed by
//                                <year>/week-<NN>/ (see computeWeekBucket)
//   <watch dir>/failed/       -> capture itself failed; a sibling
//                                <name>.error.txt explains why. Left here
//                                (not retried) so a bad file can't spin
//                                forever — Peter fixes it up and re-drops it.
//                                Deliberately flat, not date-bucketed — it's
//                                rare and manually managed, unlike processed/.

import { readdir, rename, stat, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseStructuredTranscript } from "./parseStructuredTranscript";
import { requireEnv } from "../util/env";
import { runCli } from "../util/runCli";
import { computeWeekBucket } from "../util/weekBucket";

const PROCESSING_DIR = ".processing";
const PROCESSED_DIR = "processed";
const FAILED_DIR = "failed";

// A file younger than this is skipped for this run — guards against
// ingesting a transcript that's still being written by whatever exporter
// drops it here (a truncated read would otherwise "succeed" and move to
// processed/ with no way to retry).
const MIN_AGE_MS = 2 * 60 * 1000;

// A .processing/ file whose claim is older than this is assumed to belong
// to a dead run (crashed session-limit, network drop, etc.) rather than one
// still legitimately in progress — see cmdReconcile. Chosen shorter than the
// scanfolder launchd job's 20-minute StartInterval, so a genuinely stuck
// file gets caught on the very next scheduled tick; there's no prior
// precedent for this kind of threshold elsewhere in the codebase, so treat
// it as tunable if it turns out too eager/lax in practice.
const STALE_CLAIM_MS = 15 * 60 * 1000;

async function ensureSubdirs(watchDir: string) {
  await mkdir(path.join(watchDir, PROCESSING_DIR), { recursive: true });
  await mkdir(path.join(watchDir, PROCESSED_DIR), { recursive: true });
  await mkdir(path.join(watchDir, FAILED_DIR), { recursive: true });
}

async function findCandidateFiles(watchDir: string): Promise<string[]> {
  const entries = await readdir(watchDir, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".txt")) continue;
    const fullPath = path.join(watchDir, entry.name);
    const stats = await stat(fullPath);
    if (Date.now() - stats.mtimeMs < MIN_AGE_MS) {
      console.error(`scanFolder: skipping "${entry.name}" — modified too recently, may still be writing.`);
      continue;
    }
    candidates.push(entry.name);
  }
  return candidates;
}

async function cmdList(watchDir: string): Promise<void> {
  const candidates = await findCandidateFiles(watchDir);
  console.log(JSON.stringify(candidates));
}

async function cmdClaim(watchDir: string, filename: string | undefined): Promise<void> {
  if (!filename) throw new Error("claim requires a filename argument.");

  const sourcePath = path.join(watchDir, filename);
  const lockedPath = path.join(watchDir, PROCESSING_DIR, filename);

  // Claim the file up front — cheap insurance against a still-running
  // previous scan (or a concurrently-invoked Claude Code session) double-
  // processing it.
  await rename(sourcePath, lockedPath);

  const rawText = await readFile(lockedPath, "utf-8");
  const stats = await stat(lockedPath);
  const fallbackTopic = filename.replace(/\.[^./]+$/, "").trim() || "Auto-captured meeting";
  const parsed = parseStructuredTranscript(rawText, fallbackTopic, stats.mtime);
  // Deterministic idempotency key (not LLM-inferred, same "code not
  // inference" philosophy as `parsed` above) — computed once here so the
  // caller can't hash the wrong substring or mangle a multi-KB transcript
  // through shell quoting. Carried through unchanged into the
  // upload-processed payload; see app.ts's dedup check.
  const sourceKey = `sha256:${createHash("sha256").update(rawText).digest("hex")}`;

  console.log(JSON.stringify({ rawText, parsed, sourceKey }));
}

async function cmdFinish(watchDir: string, args: string[]): Promise<void> {
  const [filename, status, ...rest] = args;
  if (!filename || (status !== "processed" && status !== "failed")) {
    throw new Error('finish requires: <file> processed|failed [--date "<ISO>"] [--error "<message>"]');
  }

  const lockedPath = path.join(watchDir, PROCESSING_DIR, filename);

  let destPath: string;
  if (status === "processed") {
    const dateFlagIndex = rest.indexOf("--date");
    const dateArg = dateFlagIndex >= 0 ? rest[dateFlagIndex + 1] : undefined;
    const parsedDate = dateArg ? new Date(dateArg) : undefined;
    // Falls back to the locked file's own mtime (e.g. a manual recovery
    // `finish` call with no --date) rather than requiring the flag —
    // matches --error's own optional-flag convention below.
    const date = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : (await stat(lockedPath)).mtime;
    const bucket = computeWeekBucket(date);
    await mkdir(path.join(watchDir, PROCESSED_DIR, bucket), { recursive: true });
    destPath = path.join(watchDir, PROCESSED_DIR, bucket, filename);
  } else {
    // failed/ stays flat, deliberately — see the file-header comment.
    destPath = path.join(watchDir, FAILED_DIR, filename);
  }

  await rename(lockedPath, destPath);

  if (status === "failed") {
    const errorFlagIndex = rest.indexOf("--error");
    const message = errorFlagIndex >= 0 ? rest[errorFlagIndex + 1] : undefined;
    if (message) {
      await writeFile(path.join(watchDir, FAILED_DIR, `${filename}.error.txt`), `${message}\n`, "utf-8");
    }
  }

  console.log(JSON.stringify({ ok: true, filename, status }));
}

async function cmdReconcile(watchDir: string): Promise<void> {
  const processingDir = path.join(watchDir, PROCESSING_DIR);
  const entries = await readdir(processingDir, { withFileTypes: true });
  const unclaimed: { filename: string; staleForMs: number }[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".txt")) continue;
    const lockedPath = path.join(processingDir, entry.name);
    const stats = await stat(lockedPath);
    // ctime (metadata-change time), not mtime (content time) — cmdClaim's
    // rename() updates ctime but not mtime, so ctimeMs on a .processing/
    // file reliably means "when was this claimed." Same
    // Date.now() - stats.X idiom as MIN_AGE_MS/findCandidateFiles above,
    // just on the opposite field and in the opposite (staleness, not
    // freshness) direction.
    const staleForMs = Date.now() - stats.ctimeMs;
    if (staleForMs < STALE_CLAIM_MS) continue;

    try {
      await rename(lockedPath, path.join(watchDir, entry.name));
      unclaimed.push({ filename: entry.name, staleForMs });
    } catch (err) {
      // Lost a race with another finish/reconcile already moving this file
      // — not worth failing the whole reconcile run over.
      console.error(`scanFolder: couldn't unclaim "${entry.name}":`, (err as Error).message);
    }
  }

  const failedEntries = await readdir(path.join(watchDir, FAILED_DIR), { withFileTypes: true });
  const failedCount = failedEntries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".txt")).length;

  console.log(JSON.stringify({ unclaimed, failedCount }));
}

// --- pull-zoom ---------------------------------------------------------------------
// Bridges the Zoom webhook's staging queue (zoom_pending_exports, populated
// by src/ingest/captureFromZoomWebhook.ts) into the watch folder. Runs before
// reconcile/list/claim in the process-transcripts skill's own run, so a
// freshly-written Zoom file is picked up in the same cycle. See
// src/server/routes/zoomExports.ts for the two endpoints this talks to.

interface ZoomPendingExport {
  id: string;
  zoomMeetingId: string;
  topic: string;
  startTime: string;
  durationMinutes?: number;
  hostEmail?: string;
  transcriptText: string;
}

function sanitizeTopicForFilename(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "meeting";
}

// Zoom UUIDs contain `/`, `+`, `=` — unsafe/ambiguous raw in a filename.
// base64url-encoding it again gives a short, filesystem-safe, deterministic
// token so a file can be traced back to its zoomMeetingId without decoding.
function zoomMeetingIdToken(zoomMeetingId: string): string {
  return Buffer.from(zoomMeetingId, "utf-8").toString("base64url").slice(0, 16);
}

function formatDateForFilename(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function buildZoomFilename(rec: ZoomPendingExport): string {
  const token = zoomMeetingIdToken(rec.zoomMeetingId);
  return `zoom_${sanitizeTopicForFilename(rec.topic)}_${formatDateForFilename(rec.startTime)}_${token}.txt`;
}

// Matches parseStructuredTranscript.ts's exact recognized shape. PARTICIPANTS
// is deliberately left with zero content lines — the host email travels as
// a "Host Email" field in MEETING INFO instead (see that file's comment),
// so the caller can attribute a real {email} participant rather than a bare
// name string that would create a second, unmatched `people` row.
function renderStructuredTranscript(rec: ZoomPendingExport): string {
  const sep = "=".repeat(60);
  const meetingInfoLines = [`Name: ${rec.topic}`, `Date/Time: ${rec.startTime}`];
  if (rec.durationMinutes != null) meetingInfoLines.push(`Duration: ${rec.durationMinutes}m`);
  if (rec.hostEmail) meetingInfoLines.push(`Host Email: ${rec.hostEmail}`);
  meetingInfoLines.push(`UUID: ${rec.zoomMeetingId}`);

  return [
    sep,
    "MEETING INFO",
    sep,
    ...meetingInfoLines,
    sep,
    "PARTICIPANTS",
    sep,
    sep,
    "TRANSCRIPT",
    sep,
    rec.transcriptText,
  ].join("\n");
}

// Only the two places an unprocessed file could still be sitting — NOT
// processed/ or failed/ (those are the upload-processed route's job to
// dedup via zoomMeetingId; scanning years of archived weekly buckets every
// 20 min would be needless I/O for a case the server already handles).
async function collectExistingZoomFilenameTokens(watchDir: string): Promise<Set<string>> {
  const dirs = [watchDir, path.join(watchDir, PROCESSING_DIR)];
  const filenames: string[] = [];
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) filenames.push(entry.name);
    }
  }
  return new Set(filenames);
}

async function cmdPullZoom(watchDir: string): Promise<void> {
  const apiBaseUrl = requireEnv("GOODWRAP_API_BASE_URL");
  const workerKey = requireEnv("LOCAL_WORKER_API_KEY");

  const res = await fetch(`${apiBaseUrl}/api/zoom/pending-exports`, {
    headers: { "x-worker-key": workerKey },
  });
  if (!res.ok) {
    throw new Error(`Zoom pull failed (${res.status}): ${await res.text()}`);
  }
  const { pendingExports } = (await res.json()) as { pendingExports: ZoomPendingExport[] };

  const existingFilenames = await collectExistingZoomFilenameTokens(watchDir);
  const written: string[] = [];

  for (const rec of pendingExports) {
    const token = zoomMeetingIdToken(rec.zoomMeetingId);
    // Still sitting unprocessed from a prior pull whose delete-confirm call
    // never landed — don't rewrite it, just retry the confirm.
    const alreadyOnDisk = [...existingFilenames].some((f) => f.includes(token));
    if (!alreadyOnDisk) {
      const filename = buildZoomFilename(rec);
      await writeFile(path.join(watchDir, filename), renderStructuredTranscript(rec), "utf-8");
      written.push(filename);
    }

    const deleteRes = await fetch(`${apiBaseUrl}/api/zoom/pending-exports/${rec.id}`, {
      method: "DELETE",
      headers: { "x-worker-key": workerKey },
    });
    if (!deleteRes.ok && deleteRes.status !== 404) {
      // The file is safely on disk either way — just log and move on rather
      // than failing the whole run over one un-confirmed delete; the next
      // pull will see the same alreadyOnDisk guard above and just retry the
      // confirm without rewriting.
      console.error(
        `scanFolder: couldn't confirm pending export ${rec.id} as delivered (${deleteRes.status}) — will retry next run.`
      );
    }
  }

  console.log(JSON.stringify({ written }));
}

async function main() {
  const watchDir = requireEnv("TRANSCRIPT_WATCH_DIR");
  await ensureSubdirs(watchDir);

  const [subcommand, ...args] = process.argv.slice(2);
  switch (subcommand) {
    case "pull-zoom":
      return cmdPullZoom(watchDir);
    case "list":
      return cmdList(watchDir);
    case "claim":
      return cmdClaim(watchDir, args[0]);
    case "finish":
      return cmdFinish(watchDir, args);
    case "reconcile":
      return cmdReconcile(watchDir);
    default:
      throw new Error(
        `Unknown subcommand "${subcommand ?? ""}". Expected one of: pull-zoom, list, claim, finish, reconcile.`
      );
  }
}

runCli("scanFolder", main);
