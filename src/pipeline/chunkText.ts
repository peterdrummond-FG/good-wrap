// Stage 2: transcript chunking, ahead of embedding.
//
// Splits on blank-line-separated blocks (speaker turns, in the Zoom-style
// transcripts this project has been fed) so chunks stay aligned to natural
// conversational boundaries rather than cutting mid-sentence or mid-turn.
// A single turn longer than maxChars is hard-split as a fallback (rare, but
// possible with a long monologue).
//
// The local embedding model (src/pipeline/embedChunks.ts, fastembed's
// bge-small-en-v1.5) truncates input at 512 tokens, silently — no error, it
// just quietly embeds less than the full chunk. For dense spoken dialogue
// (short words, filler, timestamps) that's a real risk anywhere close to the
// limit, so this is set with real headroom: ~800 chars is roughly 200-230
// tokens even for token-dense text, well under 512. Smaller chunks also
// tend to retrieve more precisely anyway, so this isn't purely a safety
// margin — it's a reasonable chunk size on its own merits.
const DEFAULT_MAX_CHARS = 800;

export function chunkTranscript(text: string, maxChars = DEFAULT_MAX_CHARS): string[] {
  const turns = text
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const turn of turns) {
    const candidate = current ? `${current}\n\n${turn}` : turn;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (turn.length <= maxChars) {
      current = turn;
    } else {
      // Single turn longer than maxChars — hard-split as a fallback so no
      // content is silently dropped.
      for (let i = 0; i < turn.length; i += maxChars) {
        chunks.push(turn.slice(i, i + maxChars));
      }
    }
  }

  if (current) chunks.push(current);

  return chunks;
}
