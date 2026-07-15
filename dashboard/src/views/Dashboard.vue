<template>
  <q-page class="q-pa-md bw-dashboard-page">
    <!--
      3 columns, left to right by default: Meetings | Meetings Overview |
      Action Items (stacked on top of Follow-ups). Reduced from 4 flat
      columns to 3 on 2026-07-16 per Peter's request — Action Items and
      Follow-ups now share one resizable column via a horizontal (top/bottom)
      q-splitter instead of each being its own top-level column.

      Every splitter model is a percentage of its own container (Quasar's
      default splitter unit), and every container is height/width: 100% down
      to the q-page itself — so the whole layout scales with the viewport
      instead of assuming a fixed pixel size anywhere. min-width/min-height:0
      on each slot (see theme.css) keeps flex children from refusing to
      shrink below their content size when the window gets narrow.
    -->
    <q-splitter
      v-model="splitOuter"
      :limits="[15, 70]"
      style="height: 100%"
      @update:model-value="saveSplits"
    >
      <template #before>
        <div class="bw-panel-slot">
          <div
            class="bw-drag-handle"
            :class="{ 'bw-drag-handle--over': dragOverIdx === 0 && dragIndex !== 0 }"
            draggable="true"
            @dragstart="onDragStart(0)"
            @dragend="onDragEnd"
            @dragover.prevent="dragOverIdx = 0"
            @dragleave="dragOverIdx = null"
            @drop="onDrop(0)"
          >
            <q-icon name="drag_indicator" size="18px" />
          </div>
          <component :is="singleComponents[columnOrder[0]]" v-if="columnOrder[0] !== 'actionstack'" />
          <ActionFollowUpStack v-else v-model="splitStack" @resized="saveSplits" />
        </div>
      </template>

      <template #after>
        <q-splitter
          v-model="splitInner1"
          :limits="[15, 80]"
          style="height: 100%"
          @update:model-value="saveSplits"
        >
          <template #before>
            <div class="bw-panel-slot">
              <div
                class="bw-drag-handle"
                :class="{ 'bw-drag-handle--over': dragOverIdx === 1 && dragIndex !== 1 }"
                draggable="true"
                @dragstart="onDragStart(1)"
                @dragend="onDragEnd"
                @dragover.prevent="dragOverIdx = 1"
                @dragleave="dragOverIdx = null"
                @drop="onDrop(1)"
              >
                <q-icon name="drag_indicator" size="18px" />
              </div>
              <component :is="singleComponents[columnOrder[1]]" v-if="columnOrder[1] !== 'actionstack'" />
              <ActionFollowUpStack v-else v-model="splitStack" @resized="saveSplits" />
            </div>
          </template>

          <template #after>
            <div class="bw-panel-slot">
              <div
                class="bw-drag-handle"
                :class="{ 'bw-drag-handle--over': dragOverIdx === 2 && dragIndex !== 2 }"
                draggable="true"
                @dragstart="onDragStart(2)"
                @dragend="onDragEnd"
                @dragover.prevent="dragOverIdx = 2"
                @dragleave="dragOverIdx = null"
                @drop="onDrop(2)"
              >
                <q-icon name="drag_indicator" size="18px" />
              </div>
              <component :is="singleComponents[columnOrder[2]]" v-if="columnOrder[2] !== 'actionstack'" />
              <ActionFollowUpStack v-else v-model="splitStack" @resized="saveSplits" />
            </div>
          </template>
        </q-splitter>
      </template>
    </q-splitter>
  </q-page>
</template>

<script setup lang="ts">
import { ref, type Component } from "vue";
import MeetingsPanel from "../components/MeetingsPanel.vue";
import MeetingsOverviewPanel from "../components/MeetingsOverviewPanel.vue";
import ActionFollowUpStack from "../components/ActionFollowUpStack.vue";

// "actionstack" is the combined Action Items (top) / Follow-ups (bottom)
// column — the two panels always keep that relative order and are dragged
// as a single unit; only which of the 3 columns they occupy is reorderable.
type ColumnKey = "meetings" | "overview" | "actionstack";

// Left-to-right default for a fresh browser with no saved localStorage yet.
const ALL_KEYS: ColumnKey[] = ["meetings", "overview", "actionstack"];

const singleComponents: Partial<Record<ColumnKey, Component>> = {
  meetings: MeetingsPanel,
  overview: MeetingsOverviewPanel,
};

// Plain localStorage, not the in-memory-only rule that applies to sandboxed
// chat artifacts — this is a real app running in the user's own browser, so
// persisting layout preferences across reloads is exactly what it's for.
const ORDER_KEY = "good-wrap-dashboard-column-order";
const SPLIT_KEY = "good-wrap-dashboard-splits-v2";

function loadOrder(): ColumnKey[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [...ALL_KEYS];
    const parsed = JSON.parse(raw);
    // A saved order from the previous 4-panel layout (or any other stale
    // shape) no longer matches — fall back to the default 3-column order
    // rather than crash or silently drop a column.
    if (
      Array.isArray(parsed) &&
      parsed.length === ALL_KEYS.length &&
      parsed.every((k) => ALL_KEYS.includes(k))
    ) {
      return parsed as ColumnKey[];
    }
  } catch {
    // malformed/stale localStorage value — fall through to the default order
  }
  return [...ALL_KEYS];
}

function loadSplits(): { outer: number; inner1: number; stack: number } {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.outer === "number" &&
        typeof parsed?.inner1 === "number" &&
        typeof parsed?.stack === "number"
      ) {
        return parsed;
      }
    }
  } catch {
    // malformed/stale value (e.g. the old 4-panel SPLIT_KEY shape) — fall
    // through to the even 3-way default instead
  }
  return { outer: 25, inner1: 37.5, stack: 55 };
}

const initialSplits = loadSplits();
const columnOrder = ref<ColumnKey[]>(loadOrder());
const splitOuter = ref(initialSplits.outer);
const splitInner1 = ref(initialSplits.inner1);
const splitStack = ref(initialSplits.stack);
const dragIndex = ref<number | null>(null);
const dragOverIdx = ref<number | null>(null);

function saveSplits() {
  localStorage.setItem(
    SPLIT_KEY,
    JSON.stringify({ outer: splitOuter.value, inner1: splitInner1.value, stack: splitStack.value })
  );
}

function onDragStart(idx: number) {
  dragIndex.value = idx;
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIdx.value = null;
}

function onDrop(idx: number) {
  dragOverIdx.value = null;
  if (dragIndex.value === null || dragIndex.value === idx) return;
  const next = [...columnOrder.value];
  const [moved] = next.splice(dragIndex.value, 1);
  next.splice(idx, 0, moved);
  columnOrder.value = next;
  localStorage.setItem(ORDER_KEY, JSON.stringify(next));
  dragIndex.value = null;
}
</script>
