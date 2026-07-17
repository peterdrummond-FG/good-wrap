// Shared wiring for MeetingActionItemsReview.vue / MeetingFollowUpsReview.vue's
// per-item mutation buttons (send-to-asana, toggle-done, delete, regenerate) —
// each button click is the same shape: mark a loading key, run the mutation,
// clear the local error banner, resync the working copy via resetCopy() once
// it succeeds, always clear the loading key. Extracted because the two review
// columns had this exact try/catch/finally wrapped around 4-5 near-identical
// handlers each, differing only in which api.ts function they called — the
// same class of duplication useReviewCategory.ts already solved for the
// review *state* itself.
//
// Each call site should get its own instance (one per button "kind": asana,
// toggle, delete, regenerate) so concurrent operations on different items
// don't share a loading key — this matches the original hand-written code,
// which used one dedicated ref per kind.

import { ref, type Ref } from "vue";

export function useKeyedAsyncAction(errorRef: Ref<string>, resetCopy: () => void) {
  const activeKey = ref<string | number | null>(null);

  async function run(key: string | number, fn: () => Promise<void>): Promise<void> {
    activeKey.value = key;
    errorRef.value = "";
    try {
      await fn();
      resetCopy();
    } catch (err) {
      errorRef.value = err instanceof Error ? err.message : String(err);
    } finally {
      activeKey.value = null;
    }
  }

  return { activeKey, run };
}
