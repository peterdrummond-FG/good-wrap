<template>
  <div class="bw-stat-tile" :class="{ 'bw-stat-tile--danger': tone === 'danger' }">
    <div class="bw-stat-tile__label">{{ label }}</div>
    <div class="bw-stat-tile__value">{{ value }}</div>
    <div v-if="sublabel" class="bw-stat-tile__sublabel">{{ sublabel }}</div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{ label: string; value: number | string; sublabel?: string; tone?: "default" | "danger" }>(),
  { tone: "default" }
);
</script>

<style scoped>
.bw-stat-tile {
  background: radial-gradient(140% 70% at 20% 0%, rgba(255, 255, 255, 0.12), transparent 55%), var(--glass-panel-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--glass-radius-lg);
  box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-highlight);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  padding: 16px 20px;
  flex: 1;
  min-width: 0;
}
.bw-stat-tile__label {
  font-size: 0.78rem;
  color: var(--bw-text-dim);
  font-weight: 600;
}
.bw-stat-tile__value {
  font-size: 2rem;
  font-weight: 700;
  color: #fff;
  line-height: 1.2;
  margin-top: 4px;
}
.bw-stat-tile__sublabel {
  font-size: 0.78rem;
  color: var(--bw-text-dim);
  margin-top: 2px;
}
</style>
