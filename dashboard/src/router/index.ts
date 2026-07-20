import { createRouter, createWebHistory } from "vue-router";
import Dashboard from "../views/Dashboard.vue";
import MeetingsView from "../views/MeetingsView.vue";
import CaptureForm from "../views/CaptureForm.vue";
import AskPage from "../views/AskPage.vue";
import PeopleList from "../views/PeopleList.vue";
import PersonDetail from "../views/PersonDetail.vue";
import Login from "../views/Login.vue";
import AuthCallback from "../views/AuthCallback.vue";
import AccountPage from "../views/AccountPage.vue";
import { supabase } from "../lib/supabaseClient";

// Routes reachable without a session — everything else requires one (see
// the beforeEach guard below).
const PUBLIC_PATHS = new Set(["/login", "/auth/callback"]);

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "dashboard", component: Dashboard },
    // Optional :id — "/meetings" (nav link, no selection) and "/meetings/:id"
    // (deep link from Capture/Ask/Person Detail) are the same calendar-day
    // screen; the id just pre-selects a meeting and jumps to its day.
    { path: "/meetings/:id?", name: "meetings", component: MeetingsView, props: true },
    { path: "/capture", name: "capture", component: CaptureForm },
    { path: "/ask", name: "ask", component: AskPage },
    { path: "/people", name: "people", component: PeopleList },
    { path: "/people/:id", name: "person-detail", component: PersonDetail, props: true },
    { path: "/login", name: "login", component: Login },
    { path: "/auth/callback", name: "auth-callback", component: AuthCallback },
    // One persistent Account screen for connecting Zoom/Asana, generating a
    // local watch-folder setup script, and (admin-only) managing the team —
    // there's no separate one-time "onboarding wizard": a first-time user
    // with nothing connected just lands here like anyone else.
    { path: "/account", name: "account", component: AccountPage },
  ],
});

// Mirrors the backend's REQUIRE_AUTH kill switch (src/server/auth.ts) —
// default off, so the app behaves exactly as it did before login existed
// until you're actually ready to require it (Supabase Auth providers
// configured, teammates invited, etc). Flip both this and the backend's
// REQUIRE_AUTH on together when that's true.
const REQUIRE_AUTH_ON_CLIENT = import.meta.env.VITE_REQUIRE_AUTH === "true";

router.beforeEach(async (to) => {
  if (!REQUIRE_AUTH_ON_CLIENT || PUBLIC_PATHS.has(to.path) || !supabase) return true;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  return true;
});

export default router;
