<template>
  <!--
    Action Items always on top, Follow-ups always below — per Peter's
    2026-07-16 request to merge these two into a single resizable column
    instead of each being its own top-level panel. The two never swap order
    (no drag handle between them); the whole stack drags as one unit at the
    Dashboard level instead. Vertical space between them is adjustable via
    q-splitter's own `horizontal` mode (top/bottom panels, horizontal
    separator line), same drag-to-resize affordance as the column splitters.
  -->
  <q-splitter
    horizontal
    :model-value="modelValue"
    :limits="[15, 85]"
    style="height: 100%"
    @update:model-value="onResize"
  >
    <template #before>
      <div class="bw-stack-slot bw-stack-slot--top">
        <ActionItemsPanel />
      </div>
    </template>

    <template #after>
      <div class="bw-stack-slot bw-stack-slot--bottom">
        <FollowUpsPanel />
      </div>
    </template>
  </q-splitter>
</template>

<script setup lang="ts">
import ActionItemsPanel from "./ActionItemsPanel.vue";
import FollowUpsPanel from "./FollowUpsPanel.vue";

defineProps<{ modelValue: number }>();
const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
  (e: "resized"): void;
}>();

function onResize(value: number) {
  emit("update:modelValue", value);
  emit("resized");
}
</script>
