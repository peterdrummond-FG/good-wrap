// Shared, module-level cache for the company list — every company
// filter/picker (Meetings page, its calendar panel, Dashboard) used to call
// fetchCompanies() independently via its own useAsyncList, tripling the
// request for data that's the same static list everywhere and changes only
// when Peter adds a new portfolio company by hand. Fetched once, reused by
// every caller.

import { ref, type Ref } from "vue";
import { fetchCompanies, type Company } from "../api";

// Sentinel for "filter down to meetings with no company tag at all" —
// distinct from `null`, which every company-filter dropdown here uses to
// mean "no filter, show everything." Shared so the Meetings page's calendar
// panel and Dashboard's stats filter agree on the same value.
export const UNCATEGORIZED_COMPANY_FILTER = "__uncategorized__";

const companies = ref<Company[]>([]) as Ref<Company[]>;
const loading = ref(true);
const error = ref("");
let started = false;

async function load(): Promise<void> {
  loading.value = true;
  try {
    companies.value = (await fetchCompanies()).companies;
    error.value = "";
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    // Logged here (not just left in `error`) since two of this composable's
    // three call sites have no error-banner UI of their own to surface it —
    // at minimum this keeps a silent failure debuggable.
    console.error("Failed to load companies:", error.value);
  } finally {
    loading.value = false;
  }
}

export function useCompanies() {
  if (!started) {
    started = true;
    void load();
  }
  return { companies, loading, error, refetch: load };
}
