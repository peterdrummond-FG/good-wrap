// Shared "fetch a list on mount, track loading/error" pattern — every widget
// that lists data off its own API call (the Meetings calendar panel,
// Dashboard's stats, the old per-meeting review panels) was hand-repeating
// the same onMounted/try/catch/finally wrapper.

import { onMounted, ref, type Ref } from "vue";

export function useAsyncList<T>(fetcher: () => Promise<T>, initial: T) {
  const data = ref(initial) as Ref<T>;
  const loading = ref(true);
  const error = ref("");

  async function load() {
    try {
      data.value = await fetcher();
      error.value = "";
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  onMounted(load);

  // Exposed so panels with mutating actions (done/delete/send) can refresh
  // their list afterward instead of patching local state by hand — cheap at
  // personal scale, and avoids drift from e.g. a delete shifting other
  // items' array indices out from under stale local state.
  return { data, loading, error, refetch: load };
}
