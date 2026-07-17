// Shared by the file-upload route and the folder auto-scan (the two paths
// that hand this module a raw .txt file with no structured input already
// known) — tries the deterministic parser for Peter's fixed export format
// first (parseStructuredTranscript.ts: free, instant, no room for the
// title/participant bugs an LLM guess can make), and only falls back to
// Claude-based inference (extractMeetingMetadata.ts) for text that doesn't
// match that structure — e.g. an arbitrary freeform transcript paste.

import { parseStructuredTranscript } from "./parseStructuredTranscript";
import { extractMeetingMetadata, type ExtractedParticipant } from "./extractMeetingMetadata";

export interface ResolvedCaptureContent {
  topic: string;
  startTime: string;
  durationMinutes?: number;
  participants: ExtractedParticipant[];
  /** The transcript to store — just the TRANSCRIPT section body when the
   * structured format matched, or the raw input verbatim otherwise. */
  transcript: string;
}

export interface ResolveCaptureContentInput {
  rawText: string;
  fallbackTopic: string;
  fallbackStartTime: Date;
}

export async function resolveCaptureContent(input: ResolveCaptureContentInput): Promise<ResolvedCaptureContent> {
  const structured = parseStructuredTranscript(input.rawText, input.fallbackTopic, input.fallbackStartTime);
  if (structured) return structured;

  const metadata = await extractMeetingMetadata(input);
  return { ...metadata, transcript: input.rawText };
}
