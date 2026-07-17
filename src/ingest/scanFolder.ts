// Folder auto-scan (Peter's "drop a .txt transcript in this folder" flow).
// Meant to be run every 20 minutes by a plain OS scheduler (macOS launchd —
// see the plist alongside this file) rather than any Claude/agent scheduler,
// so it keeps working with no session open and costs nothing per tick beyond
// the Claude API calls resolveCaptureContent/runFullPipeline may make (only
// for a file that doesn't match Peter's fixed export format — see
// parseStructuredTranscript.ts, which handles the normal case for free).
//
// One run = one pass over TRANSCRIPT_WATCH_DIR's top level:
//   <watch dir>/*.txt         -> candidates
//   <watch dir>/.processing/  -> claimed by an in-progress run (lock)
//   <watch dir>/processed/    -> captured successfully
//   <watch dir>/failed/       -> capture itself failed; a sibling
//                                <name>.error.txt explains why. Left here
//                                (not retried) so a bad file can't spin
//                                forever — Peter fixes it up and re-drops it.
//
// Usage: npm run scan-folder

import { readdir, rename, stat, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveCaptureContent } from "./resolveCaptureContent";
import { captureManualMeeting } from "./captureManualMeeting";
import { runFullPipeline } from "../pipeline/runFullPipeline";
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
      console.log(`scanFolder: skipping "${entry.name}" — modified too recently, may still be writing.`);
      continue;
    }
    candidates.push(entry.name);
  }
  return candidates;
}

async function processOne(watchDir: string, filename: string): Promise<void> {
  const sourcePath = path.join(watchDir, filename);
  const lockedPath = path.join(watchDir, PROCESSING_DIR, filename);

  // Claim the file up front — cheap insurance against a still-running
  // previous scan double-processing it (unlikely at a 20-minute interval,
  // but free to guard against).
  await rename(sourcePath, lockedPath);

  let meetingId: string;
  try {
    const rawText = await readFile(lockedPath, "utf-8");
    if (!rawText.trim()) {
      throw new Error("File is empty.");
    }

    const stats = await stat(lockedPath);
    const fallbackTopic = filename.replace(/\.[^./]+$/, "").trim() || "Auto-captured meeting";
    const metadata = await resolveCaptureContent({
      rawText,
      fallbackTopic,
      fallbackStartTime: stats.mtime,
    });

    const result = await captureManualMeeting({
      topic: metadata.topic,
      startTime: metadata.startTime,
      durationMinutes: metadata.durationMinutes,
      participants: metadata.participants,
      transcript: metadata.transcript,
      source: "upload",
    });
    meetingId = result.meetingId;
  } catch (err) {
    // Capture itself failed — quarantine so it doesn't retry forever, with
    // an error note alongside it so Peter can see what went wrong.
    const failedPath = path.join(watchDir, FAILED_DIR, filename);
    await rename(lockedPath, failedPath);
    const message = err instanceof Error ? err.message : String(err);
    await writeFile(path.join(watchDir, FAILED_DIR, `${filename}.error.txt`), `${message}\n`, "utf-8");
    console.error(`scanFolder: capture failed for "${filename}", moved to ${FAILED_DIR}/ — ${message}`);
    return;
  }

  // Capture succeeded — move to processed/ before attempting processing, same
  // "capture always succeeds independently of processing" split used
  // everywhere else in this codebase (see app.ts's POST /api/meetings).
  await rename(lockedPath, path.join(watchDir, PROCESSED_DIR, filename));
  console.log(`scanFolder: captured "${filename}" as meeting ${meetingId}.`);

  try {
    await runFullPipeline(meetingId);
  } catch (err) {
    console.error(
      `scanFolder: auto-processing failed for meeting ${meetingId} (captured fine, from "${filename}") — ` +
        `${err instanceof Error ? err.message : err}. Use the dashboard's Reprocess button to retry.`
    );
  }
}

async function main() {
  const watchDir = requireEnv("TRANSCRIPT_WATCH_DIR");
  await ensureSubdirs(watchDir);

  const candidates = await findCandidateFiles(watchDir);
  if (candidates.length === 0) {
    console.log("scanFolder: no new transcripts found.");
    return;
  }

  console.log(`scanFolder: found ${candidates.length} new transcript(s): ${candidates.join(", ")}`);
  for (const filename of candidates) {
    await processOne(watchDir, filename);
  }
}

runCli("scanFolder", main);
