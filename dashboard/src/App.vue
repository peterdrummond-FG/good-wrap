<template>
  <q-layout view="hHh LpR fFf">
    <q-header class="bw-header" bordered>
      <q-toolbar>
        <q-btn
          flat
          dense
          round
          icon="menu"
          class="bw-drawer-toggle q-mr-sm"
          aria-label="Toggle navigation menu"
          @click="drawerOpen = !drawerOpen"
        />
        <q-toolbar-title class="text-weight-medium text-grey-5" style="font-size: 0.95rem">
          {{ pageTitle }}
        </q-toolbar-title>
      </q-toolbar>
    </q-header>

    <q-drawer
      v-model="drawerOpen"
      show-if-above
      :width="188"
      side="left"
      class="bw-drawer"
      :breakpoint="DRAWER_BREAKPOINT"
    >
      <div class="column full-height bw-drawer-content">
        <div class="row items-center q-mb-md q-gutter-sm">
          <div
            class="flex flex-center"
            style="width: 32px; height: 32px; border-radius: 9px; background: var(--q-primary); flex-shrink: 0"
          >
            <q-icon name="smart_toy" color="white" size="18px" />
          </div>
          <div class="text-weight-bold text-white">good-wrap</div>
        </div>

        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="bw-nav-item"
          :class="{ 'bw-nav-item--active': isActive(item.to) }"
          @click="onNavClick"
        >
          <q-icon :name="item.icon" size="18px" />
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
// Drives the drawer below its 700px breakpoint (see the q-drawer's
// :breakpoint prop) — above it, show-if-above keeps the drawer docked open
// regardless of this value. Added for the UI/UX pass, 2026-07-17: previously
// there was no toggle at all, so the nav became completely unreachable below
// 700px (show-if-above hides it, and nothing could open it back up).
const drawerOpen = ref(false);
// Must match the q-drawer's own :breakpoint prop below.
const DRAWER_BREAKPOINT = 700;

// Regression fixed 2026-07-17: this used to unconditionally set
// drawerOpen = false on every nav click, including on desktop. show-if-above
// only forces the drawer open automatically when *crossing* above the
// breakpoint — once mounted above it, an explicit v-model write (like that
// unconditional close) is respected and actually hides the docked drawer,
// with no way to reopen it since the toggle button is CSS-hidden above the
// breakpoint. Only auto-close below the breakpoint, where the drawer is an
// overlay the user expects to dismiss after picking a destination.
function onNavClick() {
  if (window.innerWidth < DRAWER_BREAKPOINT) drawerOpen.value = false;
}

const navItems = [
  { to: "/", label: "Dashboard", icon: "space_dashboard" },
  { to: "/meetings", label: "Meetings", icon: "event" },
  { to: "/capture", label: "Capture", icon: "add_circle" },
  { to: "/ask", label: "Ask", icon: "forum" },
  { to: "/people", label: "People", icon: "group" },
];

function isActive(to: string): boolean {
  if (to === "/") return route.path === "/";
  return route.path.startsWith(to);
}

const pageTitle = computed(() => {
  if (route.path === "/") return "Dashboard";
  if (route.path.startsWith("/people/")) return "Person";
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
  background: rgba(23, 24, 28, 0.68);
  border-bottom-color: var(--glass-border) !important;
}
.bw-drawer {
  background: var(--glass-drawer-bg);
  border-right: 1px solid var(--glass-border);
}
/* Replaces the old q-pa-md (16px all round) — narrower to leave more room
   for the main content next to it (Peter's ask, 2026-07-17), on top of the
   drawer itself shrinking from 240px to 188px. */
.bw-drawer-content {
  padding: 12px 10px;
}
/* Matches the q-drawer's own :breakpoint="700" exactly — above it the
   drawer is permanently docked open (show-if-above), so the toggle would be
   dead weight in the header; below it, it's the only way to reach nav. */
.bw-drawer-toggle {
  display: none;
}
@media (max-width: 699px) {
  .bw-drawer-toggle {
    display: inline-flex;
  }
}
</style>
