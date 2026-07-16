// Shared "fetch a list on mount, track loading/error" pattern — every
// dashboard panel (MeetingsPanel, MeetingsOverviewPanel, ActionItemsPanel,
// FollowUpsPanel) was hand-repeating the same onMounted/try/catch/finally
// wrapper around its own single API call.

import { onMounted, ref, type Ref } from "vue";

export function useAsyncList<T>(fetcher: () => Promise<T>, initial: T) {
  const data = ref(initial) as Ref<T>;
  const loading = ref(true);
  const error = ref("");

  onMounted(async () => {
    try {
      data.value = await fetcher();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  });

  return { data, loading, error };
}
