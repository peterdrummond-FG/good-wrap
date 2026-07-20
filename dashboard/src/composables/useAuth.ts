// Session + resolved app-user state — shared module-level singleton (same
// pattern as useCompanies.ts) so every component reads the same reactive
// session instead of each re-subscribing to Supabase independently.
//
// Works fine when Supabase Auth isn't configured at all yet (supabase ===
// null, see ../lib/supabaseClient.ts) — session/appUser just stay null and
// initializing resolves immediately, matching the pre-login "no current
// user" state rather than crashing.

import { ref, type Ref } from "vue";
import type { AuthError, Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";
import { fetchCurrentUser, type CurrentUser } from "../api";

const session = ref<Session | null>(null) as Ref<Session | null>;
// The good-wrap `users` row this session resolves to (via GET /api/me) —
// null while initializing, and also null for a validly-signed-in Google/
// Microsoft account that isn't on the invite list (403 from /api/me).
const appUser = ref<CurrentUser | null>(null) as Ref<CurrentUser | null>;
const initializing = ref(true);
let started = false;

// Deliberately does NOT gate on session.value being set — the backend
// resolves a legacy fallback user (DEFAULT_OWNER_EMAIL) for unauthenticated
// requests whenever its own REQUIRE_AUTH is off (src/server/auth.ts), so
// GET /api/me still succeeds with no session at all in that rollout state.
// Once REQUIRE_AUTH is actually on, an unauthenticated call here just fails
// (401/403) and the catch below leaves appUser null, same as today.
async function refreshAppUser(): Promise<void> {
  try {
    appUser.value = (await fetchCurrentUser()).user;
  } catch (err) {
    // Not signed in, not invited, or some other resolution failure.
    appUser.value = null;
    console.error("Failed to resolve current good-wrap user:", err);
  }
}

function start(): void {
  if (started) return;
  started = true;

  if (!supabase) {
    void refreshAppUser().finally(() => {
      initializing.value = false;
    });
    return;
  }

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

const notConfiguredError = (): { data: { provider: null; url: null }; error: AuthError } => ({
  data: { provider: null, url: null },
  error: {
    name: "AuthUnavailableError",
    message: "Supabase Auth isn't configured yet — set VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY (see .env.example).",
  } as AuthError,
});

export function useAuth() {
  start();
  return {
    session,
    appUser,
    initializing,
    signInWithGoogle: () =>
      supabase
        ? supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } })
        : Promise.resolve(notConfiguredError()),
    signInWithMicrosoft: () =>
      supabase
        ? supabase.auth.signInWithOAuth({ provider: "azure", options: { redirectTo: redirectTo() } })
        : Promise.resolve(notConfiguredError()),
    signOut: () => (supabase ? supabase.auth.signOut() : Promise.resolve({ error: null })),
  };
}
