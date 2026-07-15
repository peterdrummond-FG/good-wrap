<template>
  <q-page class="q-pa-md" style="height: calc(100vh - 50px)">
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
          <component :is="panelComponents[panelOrder[0]]" />
        </div>
      </template>

      <template #after>
        <q-splitter
          v-model="splitInner"
          :limits="[20, 80]"
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
              <component :is="panelComponents[panelOrder[1]]" />
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
              <component :is="panelComponents[panelOrder[2]]" />
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
import FollowUpsPanel from "../components/FollowUpsPanel.vue";

type PanelKey = "meetings" | "overview" | "followups";

const ALL_KEYS: PanelKey[] = ["meetings", "overview", "followups"];

const panelComponents: Record<PanelKey, Component> = {
  meetings: MeetingsPanel,
  overview: MeetingsOverviewPanel,
  followups: FollowUpsPanel,
};

// Plain localStorage, not the in-memory-only rule that applies to sandboxed
// chat artifacts — this is a real app running in the user's own browser, so
// persisting layout preferences across reloads is exactly what it's for.
const ORDER_KEY = "good-wrap-dashboard-panel-order";
const SPLIT_KEY = "good-wrap-dashboard-splits";

function loadOrder(): PanelKey[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [...ALL_KEYS];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((k) => ALL_KEYS.includes(k))) {
      return parsed as PanelKey[];
    }
  } catch {
    // malformed/stale localStorage value — fall through to the default order
  }
  return [...ALL_KEYS];
}

function loadSplits(): { outer: number; inner: number } {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // malformed/stale value — fall through to the even 3-way default
  }
  return { outer: 33.33, inner: 50 };
}

const initialSplits = loadSplits();
const panelOrder = ref<PanelKey[]>(loadOrder());
const splitOuter = ref(initialSplits.outer);
const splitInner = ref(initialSplits.inner);
const dragIndex = ref<number | null>(null);
const dragOverIdx = ref<number | null>(null);

function saveSplits() {
  localStorage.setItem(
    SPLIT_KEY,
    JSON.stringify({ outer: splitOuter.value, inner: splitInner.value })
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
  const next = [...panelOrder.value];
  const [moved] = next.splice(dragIndex.value, 1);
  next.splice(idx, 0, moved);
  panelOrder.value = next;
  localStorage.setItem(ORDER_KEY, JSON.stringify(next));
  dragIndex.value = null;
}
</script>
