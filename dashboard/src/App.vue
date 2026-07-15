<template>
  <q-layout view="hHh LpR fFf">
    <q-header class="bw-header" bordered>
      <q-toolbar>
        <q-toolbar-title class="text-weight-medium text-grey-5" style="font-size: 0.95rem">
          {{ pageTitle }}
        </q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above :width="240" side="left" class="bw-drawer" :breakpoint="700">
      <div class="column full-height q-pa-md">
        <div class="row items-center q-mb-lg q-gutter-sm">
          <div
            class="flex flex-center"
            style="width: 36px; height: 36px; border-radius: 10px; background: var(--q-primary)"
          >
            <q-icon name="smart_toy" color="white" size="20px" />
          </div>
          <div class="text-weight-bold text-white">good-wrap</div>
        </div>

        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="bw-nav-item"
          :class="{ 'bw-nav-item--active': isActive(item.to) }"
        >
          <q-icon :name="item.icon" size="20px" />
          {{ item.label }}
        </router-link>

        <q-space />

        <!-- Added 2026-07-16 — no real auth yet (personal-use POC), but this
             makes the existing implicit "current user" assumption
             (DEFAULT_OWNER_EMAIL, see GET /api/me) visible instead of
             invisible, and gives a place to eventually swap in real
             session info once this lives inside the hub app. -->
        <div v-if="currentUser" class="text-caption text-grey-6 q-pa-sm">
          Signed in as <span class="text-grey-4">{{ currentUser.name }}</span>
        </div>
        <div class="text-caption text-grey-7 q-pa-sm">Meeting Intelligence — POC</div>
      </div>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { fetchCurrentUser, type CurrentUser } from "./api";

const route = useRoute();
const currentUser = ref<CurrentUser | null>(null);

const navItems = [
  { to: "/", label: "Dashboard", icon: "space_dashboard" },
  { to: "/capture", label: "Capture", icon: "add_circle" },
  { to: "/ask", label: "Ask", icon: "forum" },
];

function isActive(to: string): boolean {
  if (to === "/") return route.path === "/";
  return route.path.startsWith(to);
}

const pageTitle = computed(() => {
  if (route.path === "/") return "Dashboard";
  if (route.path.startsWith("/meetings/")) return "Meeting";
  const match = navItems.find((i) => i.to !== "/" && route.path.startsWith(i.to));
  return match?.label ?? "good-wrap";
});

onMounted(async () => {
  try {
    const result = await fetchCurrentUser();
    currentUser.value = result.user;
  } catch {
    // No current user (DEFAULT_OWNER_EMAIL unset/invalid) — leave the
    // sidebar indicator hidden rather than surfacing an error for something
    // this minor; the rest of the app will fail loudly elsewhere if this is
    // actually misconfigured.
  }
});
</script>

<style scoped>
.bw-header {
  background: var(--q-dark-page);
}
.bw-drawer {
  background: var(--bw-surface);
  border-right: 1px solid var(--bw-border);
}
</style>
