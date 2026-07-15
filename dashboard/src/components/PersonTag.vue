<template>
  <!-- Small colored-dot + name chip, added 2026-07-16 so a person's name
       reads consistently everywhere it appears (Follow-ups "with X",
       person-grouped section headers, meeting participant lists). Plain
       inline element (not a q-chip) so it flows naturally inside existing
       text-heavy captions instead of forcing its own block/padding. -->
  <span class="bw-person-tag">
    <span class="bw-person-tag__dot" :style="{ background: color }" />{{ name }}
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { personColor } from "../personColor";

const props = defineProps<{ name: string }>();
const color = computed(() => personColor(props.name));
</script>
