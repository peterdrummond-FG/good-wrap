<template>
  <!-- Logo-only badge, added 2026-07-17 for at-a-glance company tagging (see
       db/schema.ts's companies comment). No name text alongside the logo —
       the whole point is that a recognizable logo reads faster than a text
       label, and it needs to fit inline in space-constrained spots (calendar
       blocks, list rows) as well as the meeting detail header. Falls back to
       a colored-initials swatch (same pattern as PersonTag's dot) so a
       company with no logo file placed yet still shows something
       recognizable instead of a broken image. -->
  <span class="bw-company-tag" :title="company.name">
    <img
      v-if="logoSrc"
      :src="logoSrc"
      :alt="company.name"
      class="bw-company-tag__logo"
      @error="onImgError"
    />
    <span v-else class="bw-company-tag__fallback" :style="{ background: fallbackColor }">{{ initials }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Company } from "../api";
import { personColor } from "../personColor";

const props = defineProps<{ company: Company }>();

// Logos were dropped in as a mix of .svg and .png (see that folder's
// README) — try each extension in turn, falling back to the colored-initials
// badge only once every extension has 404'd for this company's slug.
const EXTENSIONS = ["svg", "png"];
const extensionIndex = ref(0);

watch(
  () => props.company.slug,
  () => {
    extensionIndex.value = 0;
  }
);

const logoSrc = computed(() =>
  extensionIndex.value < EXTENSIONS.length
    ? `/logos/${props.company.slug}.${EXTENSIONS[extensionIndex.value]}`
    : null
);

function onImgError() {
  extensionIndex.value += 1;
}

const initials = computed(() =>
  props.company.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 3)
    .toUpperCase()
);

// Reuses PersonTag's name-hash palette so a company without a logo yet still
// gets a stable, distinct color rather than every unlabeled company looking
// identical.
const fallbackColor = computed(() => personColor(props.company.name));
</script>

<style scoped>
.bw-company-tag {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  line-height: 0;
}
.bw-company-tag__logo {
  height: 20px;
  width: 20px;
  object-fit: contain;
}
.bw-company-tag__fallback {
  height: 20px;
  min-width: 20px;
  padding: 0 3px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6rem;
  font-weight: 700;
  color: #111;
  line-height: 1;
}
</style>
