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
//                                     { rawText, parsed } as JSON. `parsed`
//                                     is Peter's fixed-export metadata (see
//                                     parseStructuredTranscript.ts) or null
//                                     if the file doesn't match that shape —
//                                     the caller (a Claude Code session)
//                                     reads rawText itself to infer metadata
//                                     in that case, with no Claude API call.
//   finish <file> processed|failed [--error "<message>"]
//                                 -> moves the claimed file to its final
//                                     resting place
//
// Directory layout (unchanged from before):
//   <watch dir>/*.txt         -> candidates
//   <watch dir>/.processing/  -> claimed by an in-progress run (lock)
//   <watch dir>/processed/    -> captured successfully
//   <watch dir>/failed/       -> capture itself failed; a sibling
//                                <name>.error.txt explains why. Left here
//                                (not retried) so a bad file can't spin
//                                forever — Peter fixes it up and re-drops it.

import { readdir, rename, stat, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseStructuredTranscript } from "./parseStructuredTranscript";
import { requireEnv } from "../util/env";
import { runCli } from "../util/runCli";

const PROCESSING_DIR = ".processing";
const PROCESSED_DIR = "processed";
const FAILED_DIR = "failed";

// A file younger than this is skipped for this run — guards against
// ingesting a transcript that's still being written by whatever exporter
// drops it here (a truncated read would otherwise "succeed" and move to
// processed/ with no way to retry).
const MIN_AGE_MS = 2 * 60 * 1000;

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

  console.log(JSON.stringify({ rawText, parsed }));
}

async function cmdFinish(watchDir: string, args: string[]): Promise<void> {
  const [filename, status, ...rest] = args;
  if (!filename || (status !== "processed" && status !== "failed")) {
    throw new Error('finish requires: <file> processed|failed [--error "<message>"]');
  }

  const lockedPath = path.join(watchDir, PROCESSING_DIR, filename);
  const destDir = status === "processed" ? PROCESSED_DIR : FAILED_DIR;
  await rename(lockedPath, path.join(watchDir, destDir, filename));

  if (status === "failed") {
    const errorFlagIndex = rest.indexOf("--error");
    const message = errorFlagIndex >= 0 ? rest[errorFlagIndex + 1] : undefined;
    if (message) {
      await writeFile(path.join(watchDir, FAILED_DIR, `${filename}.error.txt`), `${message}\n`, "utf-8");
    }
  }

  console.log(JSON.stringify({ ok: true, filename, status }));
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
    default:
      throw new Error(`Unknown subcommand "${subcommand ?? ""}". Expected one of: list, claim, finish.`);
  }
}

runCli("scanFolder", main);
