<template>
  <div class="bw-row row items-center q-gutter-sm no-wrap">
    <div class="flex flex-center" style="width: 32px; height: 32px; border-radius: 9px; background: rgba(255,255,255,0.08)">
      <q-icon :name="icon" size="18px" />
    </div>
    <div class="col">
      <div class="text-weight-medium">{{ label }}</div>
      <div class="text-caption text-grey-6">
        {{ connection?.connected ? `Connected as ${connection.accountEmail ?? "unknown account"}` : "Not connected" }}
      </div>
    </div>
    <q-btn
      v-if="connection?.connected"
      flat
      dense
      no-caps
      color="negative"
      label="Disconnect"
      :loading="loading"
      @click="$emit('disconnect')"
    />
    <q-btn v-else unelevated dense no-caps color="primary" label="Connect" :loading="loading" @click="$emit('connect')" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { IntegrationConnection, IntegrationProviderName } from "../api";

const props = defineProps<{
  provider: IntegrationProviderName;
  connection: IntegrationConnection | undefined;
  loading: boolean;
}>();

defineEmits<{ connect: []; disconnect: [] }>();

const label = computed(() => (props.provider === "zoom" ? "Zoom" : "Asana"));
const icon = computed(() => (props.provider === "zoom" ? "videocam" : "task_alt"));
</script>
