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
              <component :is="panelComponents[panelOrder[1]]" />
            </div>
          </template>

          <template #after>
            <q-splitter
              v-model="splitInner2"
              :limits="[20, 80]"
              style="height: 100%"
              @update:model-value="saveSplits"
            >
              <template #before>
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

              <template #after>
                <div class="bw-panel-slot">
                  <div
                    class="bw-drag-handle"
                    :class="{ 'bw-drag-handle--over': dragOverIdx === 3 && dragIndex !== 3 }"
                    draggable="true"
                    @dragstart="onDragStart(3)"
                    @dragend="onDragEnd"
                    @dragover.prevent="dragOverIdx = 3"
                    @dragleave="dragOverIdx = null"
                    @drop="onDrop(3)"
                  >
                    <q-icon name="drag_indicator" size="18px" />
                  </div>
                  <component :is="panelComponents[panelOrder[3]]" />
                </div>
              </template>
            </q-splitter>
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
import ActionItemsPanel from "../components/ActionItemsPanel.vue";

type PanelKey = "meetings" | "overview" | "followups" | "actionitems";

// Order here is also the default layout (left to right) for a fresh
// browser with no saved localStorage yet — Action Items added 2026-07-16
// as its own panel (was briefly merged into Follow-ups, split back out per
// Peter's request), placed last/rightmost by default since that's roughly
// where he wanted it; drag-reorder (see onDrop) moves it from there.
const ALL_KEYS: PanelKey[] = ["meetings", "overview", "followups", "actionitems"];

const panelComponents: Record<PanelKey, Component> = {
  meetings: MeetingsPanel,
  overview: MeetingsOverviewPanel,
  followups: FollowUpsPanel,
  actionitems: ActionItemsPanel,
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
    // A saved order from before Action Items existed (length 3) no longer
    // matches — fall back to the default 4-panel order rather than crash
    // or silently drop a panel.
    if (
      Array.isArray(parsed) &&
      parsed.length === ALL_KEYS.length &&
      parsed.every((k) => ALL_KEYS.includes(k))
    ) {
      return parsed as PanelKey[];
    }
  } catch {
    // malformed/stale localStorage value — fall through to the default order
  }
  return [...ALL_KEYS];
}

function loadSplits(): { outer: number; inner1: number; inner2: number } {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Accept the current 3-value shape; fall back to even quarters for
      // anything else (e.g. a pre-Action-Items save with only outer/inner).
      if (
        typeof parsed?.outer === "number" &&
        typeof parsed?.inner1 === "number" &&
        typeof parsed?.inner2 === "number"
      ) {
        return parsed;
      }
    }
  } catch {
    // malformed/stale value — fall through to the even 4-way default
  }
  return { outer: 25, inner1: 33.33, inner2: 50 };
}

const initialSplits = loadSplits();
const panelOrder = ref<PanelKey[]>(loadOrder());
const splitOuter = ref(initialSplits.outer);
const splitInner1 = ref(initialSplits.inner1);
const splitInner2 = ref(initialSplits.inner2);
const dragIndex = ref<number | null>(null);
const dragOverIdx = ref<number | null>(null);

function saveSplits() {
  localStorage.setItem(
    SPLIT_KEY,
    JSON.stringify({ outer: splitOuter.value, inner1: splitInner1.value, inner2: splitInner2.value })
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
