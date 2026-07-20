// Session + resolved app-user state — shared module-level singleton (same
// pattern as useCompanies.ts) so every component reads the same reactive
// session instead of each re-subscribing to Supabase independently.

import { ref, type Ref } from "vue";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";
import { fetchCurrentUser, type CurrentUser } from "../api";

const session = ref<Session | null>(null) as Ref<Session | null>;
// The good-wrap `users` row this session resolves to (via GET /api/me) —
// null while initializing, and also null for a validly-signed-in Google/
// Microsoft account that isn't on the invite list (403 from /api/me).
const appUser = ref<CurrentUser | null>(null) as Ref<CurrentUser | null>;
const initializing = ref(true);
let started = false;

async function refreshAppUser(): Promise<void> {
  if (!session.value) {
    appUser.value = null;
    return;
  }
  try {
    appUser.value = (await fetchCurrentUser()).user;
  } catch (err) {
    // Not invited, or some other resolution failure — no app user yet.
    appUser.value = null;
    console.error("Failed to resolve current good-wrap user:", err);
  }
}

function start(): void {
  if (started) return;
  started = true;

  void supabase.auth.getSession().then(async ({ data }) => {
    session.value = data.session;
    await refreshAppUser();
    initializing.value = false;
  });

  supabase.auth.onAuthStateChange((_event, newSession) => {
    session.value = newSession;
    void refreshAppUser();
  });
}

const redirectTo = () => `${window.location.origin}/auth/callback`;

export function useAuth() {
  start();
  return {
    session,
    appUser,
    initializing,
    signInWithGoogle: () => supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } }),
    signInWithMicrosoft: () => supabase.auth.signInWithOAuth({ provider: "azure", options: { redirectTo: redirectTo() } }),
    signOut: () => supabase.auth.signOut(),
  };
}
