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

async function main() {
  const watchDir = requireEnv("TRANSCRIPT_WATCH_DIR");
  await ensureSubdirs(watchDir);

  const [subcommand, ...args] = process.argv.slice(2);
  switch (subcommand) {
    case "list":
      return cmdList(watchDir);
    case "claim":
      return cmdClaim(watchDir, args[0]);
    case "finish":
      return cmdFinish(watchDir, args);
    case "reconcile":
      return cmdReconcile(watchDir);
    default:
      throw new Error(`Unknown subcommand "${subcommand ?? ""}". Expected one of: list, claim, finish, reconcile.`);
  }
}

runCli("scanFolder", main);
