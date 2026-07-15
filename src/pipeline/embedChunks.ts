// Stage 2/5: transcript chunk + query embeddings — run entirely locally.
//
// No external embeddings API/account (Peter's call: avoid adding another
// paid vendor on top of the Claude API). fastembed runs a small open-source
// embedding model (BAAI/bge-small-en-v1.5) directly in Node via ONNX Runtime.
// Deliberately not @xenova/transformers: that library pulls in `sharp`
// (image processing) as a hard dependency even for text-only use, which
// failed to install cleanly in testing. fastembed has no such baggage.
//
// First call downloads the model (~130MB) and caches it on disk — in
// FASTEMBED_CACHE_DIR if set, otherwise fastembed's own default, a
// `local_cache/` folder created in the project root (gitignored — see
// .gitignore). Every call after that first download is fully offline, free,
// and fast enough for personal-scale batches.
//
// 384-dim output — must match db/schema.ts's `vector(384)` column. If you
// ever swap models, update both together (see the comment in schema.ts).
//
// BGE models are trained for *asymmetric* search: documents and queries are
// embedded slightly differently for better retrieval. `embedChunks` embeds
// transcript chunks as passages (Stage 2); `embedQuery` embeds a
// natural-language question (Stage 5) — always use the matching function,
// don't reuse one for the other.

import { EmbeddingModel, FlagEmbedding } from "fastembed";
import { withRetry } from "../util/retry";

// Lowered from 32 (2026-07-15): Railway's plan caps this service at 1GB
// memory with no headroom to raise it, and a batch of 32 chunks' worth of
// simultaneous ONNX tensors was enough to OOM-kill the container during
// /process on at least one meeting. Smaller batches trade a bit of speed
// for materially lower peak memory per embedding call.
const PASSAGE_BATCH_SIZE = 8;

let modelPromise: Promise<FlagEmbedding> | null = null;

function getModel(): Promise<FlagEmbedding> {
  if (!modelPromise) {
    modelPromise = FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      // `|| undefined`, not left as-is: an empty string in .env (FASTEMBED_CACHE_DIR=)
      // is not the same as unset, and would override fastembed's own "local_cache"
      // default with an invalid empty path. Same class of bug as the CLAUDE_MODEL fix.
      cacheDir: process.env.FASTEMBED_CACHE_DIR || undefined,
    }).catch((err) => {
      // Don't cache a rejected promise — a transient failure (e.g. a blip on
      // the first-time model download) would otherwise permanently poison
      // every future call, defeating the retry below.
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

/** Embed a batch of transcript chunks as passages (used by Stage 2). */
export async function embedChunks(chunks: string[]): Promise<number[][]> {
  if (chunks.length === 0) return [];

  return withRetry(
    async () => {
      const model = await getModel();
      const embeddings: number[][] = [];

      for await (const batch of model.passageEmbed(chunks, PASSAGE_BATCH_SIZE)) {
        embeddings.push(...batch);
      }

      return embeddings;
    },
    {
      onRetry: (err, attempt) =>
        console.warn(
          `embedChunks: attempt ${attempt} failed, retrying — ${err instanceof Error ? err.message : err}`
        ),
    }
  );
}

/** Embed a single natural-language question (used by Stage 5's Q&A). */
export async function embedQuery(query: string): Promise<number[]> {
  return withRetry(
    async () => {
      const model = await getModel();
      return model.queryEmbed(query);
    },
    {
      onRetry: (err, attempt) =>
        console.warn(
          `embedQuery: attempt ${attempt} failed, retrying — ${err instanceof Error ? err.message : err}`
        ),
    }
  );
}
