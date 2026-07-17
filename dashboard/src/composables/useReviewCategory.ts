// Shared state/logic behind MeetingActionItemsReview.vue and
// MeetingFollowUpsReview.vue's review columns — before this existed, the two
// were ~150 lines of hand-duplicated (and easy to let drift) parallel state:
// a working copy of that category's candidates, a dirty-tracking baseline
// snapshot, edit-mode toggle, per-panel save, and reseed-from-server.
// Parametrized by category so both columns share one implementation instead
// of two copies that only differ in field shape (Follow-ups has `person`,
// Action Items doesn't) and whether the list is urgency-sorted (Follow-ups
// is, Action Items isn't).
//
// Error handling and success/failure Notify toasts stay in each of those
// components (page-level concerns) — `save()` here just does the state work
// and lets a rejection propagate to the caller's own try/catch.

import { computed, reactive, ref, type Ref } from "vue";
import { submitMeetingReview, type MeetingDetail, type SubmitReviewInput, type SubmitReviewResult } from "../api";

export interface ReviewCategoryConfig<TItem extends { text: string; approved: boolean }> {
  meetingId: string;
  meeting: Ref<MeetingDetail | null>;
  /** Pulls this category's current candidates + reviewed-at off a meeting
   * that's confirmed to have insights loaded. */
  read: (meeting: MeetingDetail) => { items: TItem[]; reviewedAt: string | null };
  /** Item this category's "add your own" row creates from free-text input. */
  makeNewItem: (text: string) => TItem;
  /** Canonical shape for dirty-tracking — only the real fields, so an
   * incidental property on the reactive() proxy can't cause a false-dirty. */
  snapshotFields: (item: TItem) => unknown;
  /** Applied to both the review checklist and the read-only approved list.
   * Omit for a category with no ranking (Action Items). */
  sortForDisplay?: (items: TItem[]) => TItem[];
  /** This category's slice of the review-submit payload. */
  buildPayload: (items: TItem[]) => SubmitReviewInput;
  /** Whether THIS call's response is what just moved this category from
   * needs-review to reviewed. */
  readJustReviewed: (result: SubmitReviewResult) => boolean;
}

export function useReviewCategory<TItem extends { text: string; approved: boolean }>(
  config: ReviewCategoryConfig<TItem>
) {
  const items = ref<TItem[]>([]) as Ref<TItem[]>;
  const editMode = ref(false);
  const saving = ref(false);
  const baseline = ref("[]");
  const newItemText = ref("");

  function readCategory(): { items: TItem[]; reviewedAt: string | null } {
    const m = config.meeting.value;
    if (!m?.insights) return { items: [], reviewedAt: null };
    return config.read(m);
  }

  function snapshot(): string {
    return JSON.stringify(items.value.map(config.snapshotFields));
  }

  const dirty = computed(() => snapshot() !== baseline.value);

  const showChecklist = computed(() => !readCategory().reviewedAt || editMode.value);

  const displayItems = computed(() =>
    config.sortForDisplay ? config.sortForDisplay(items.value) : items.value
  );

  const approvedItems = computed(() => {
    const approved = readCategory().items.filter((i) => i.approved);
    return config.sortForDisplay ? config.sortForDisplay(approved) : approved;
  });

  /** Re-seeds the working copy (+ dirty-tracking baseline) from the latest
   * fetched meeting — initial load, after this category's own save, and
   * after this category's own regenerate. */
  function resetCopy() {
    items.value = readCategory().items.map((i) => reactive({ ...i })) as TItem[];
    baseline.value = snapshot();
  }

  function addItem() {
    const text = newItemText.value.trim();
    if (text) items.value.push(reactive(config.makeNewItem(text)) as TItem);
    newItemText.value = "";
  }

  /** Persists the working copy as this category's approved selections. */
  async function save(): Promise<{ justReviewed: boolean }> {
    saving.value = true;
    try {
      const result = await submitMeetingReview(config.meetingId, config.buildPayload(items.value));
      config.meeting.value = result.meeting;
      resetCopy();
      editMode.value = false;
      return { justReviewed: config.readJustReviewed(result) };
    } finally {
      saving.value = false;
    }
  }

  return {
    items,
    displayItems,
    approvedItems,
    showChecklist,
    editMode,
    saving,
    dirty,
    newItemText,
    addItem,
    resetCopy,
    save,
  };
}
