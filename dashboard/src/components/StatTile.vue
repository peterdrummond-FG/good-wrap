<template>
  <div class="bw-stat-tile">
    <div class="bw-stat-tile__label">{{ label }}</div>
    <div class="bw-stat-tile__value">{{ value }}</div>
    <div v-if="sublabel" class="bw-stat-tile__sublabel">{{ sublabel }}</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ label: string; value: number | string; sublabel?: string }>();
</script>

<style scoped>
.bw-stat-tile {
  background: var(--bw-surface);
  border: 1px solid var(--bw-border);
  border-radius: 16px;
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
