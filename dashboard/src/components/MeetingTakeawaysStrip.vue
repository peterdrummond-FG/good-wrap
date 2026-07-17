<template>
  <!-- Deliberately low-weight per Peter's request: a single compact strip
       above Action Items/Follow-ups, not its own full-height column like the
       old MeetingDetail.vue layout. The pencil only reveals "Regenerate" —
       there's nothing else to edit here (see MeetingDetail.vue's original
       Takeaways column comment: no per-item approval concept). -->
  <div class="bw-takeaways-strip">
    <div class="row items-center justify-between no-wrap">
      <div class="bw-takeaways-strip__label">Takeaways</div>
      <q-btn
        flat round dense size="xs" icon="edit" color="grey-6"
        @click="showRegenerate = !showRegenerate"
      />
    </div>
    <div class="bw-takeaways-strip__list">
      <template v-if="topTakeaways.length">
        <span v-for="(t, i) in topTakeaways" :key="i" class="bw-takeaways-strip__item">
          {{ t.text }}<span v-if="i < topTakeaways.length - 1" class="bw-takeaways-strip__sep">·</span>
        </span>
      </template>
      <span v-else class="text-grey-6">(none suggested)</span>
    </div>
    <q-btn
      v-if="showRegenerate"
      flat dense no-caps size="sm" icon="autorenew" label="Regenerate takeaways"
      class="q-mt-xs"
      :loading="regenerating"
      @click="$emit('regenerate')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { SuggestionItem } from "../api";

const props = defineProps<{ takeaways: SuggestionItem[]; regenerating: boolean }>();
defineEmits<{ (e: "regenerate"): void }>();

const showRegenerate = ref(false);

// Caps a takeaway to a handful of words so the strip stays a quick glance
// rather than a wall of text — the review column below is where the full
// wording lives.
function truncateWords(text: string, maxWords = 10): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(" ")}…`;
}

// Only the top 3 — Peter's call: this strip is meant to be a quick glance,
// not a full readout (the review columns below are where the depth lives).
// Same "top 3" convention MeetingListItem.topTakeaways already uses
// elsewhere (see api.ts), just applied here to the full per-meeting list.
//
// `props.takeaways ?? []` guards a real crash seen in testing: this prop is
// only ever read once `meeting.insights` is truthy (see MeetingsView.vue),
// but insights.takeaways itself can still come back null/undefined for a
// meeting whose insights row predates full normalization (queries.ts's
// normalizeTakeaways exists for exactly this reason on the read side —
// this is the same defense on the display side).
const topTakeaways = computed(() =>
  (props.takeaways ?? []).slice(0, 3).map((t) => ({ ...t, text: truncateWords(t.text) }))
);
</script>

<style scoped>
.bw-takeaways-strip {
  background: var(--bw-surface-raised);
  border: 1px solid var(--bw-border);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.bw-takeaways-strip__label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--bw-text-dim);
}
.bw-takeaways-strip__list {
  font-size: 0.85rem;
  color: #e7e8ec;
  line-height: 1.5;
  margin-top: 4px;
}
.bw-takeaways-strip__sep {
  margin: 0 6px;
  color: var(--bw-text-dim);
}
</style>
