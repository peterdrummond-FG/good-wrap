// Supabase Auth client — used ONLY for authentication (Google/Microsoft SSO
// session issuance), not as a database client. The dashboard still talks to
// good-wrap's own Fastify API (see ../api.ts) for all data; this just
// supplies the bearer token that API now requires (see src/server/auth.ts).
//
// Deliberately tolerant of missing config: login is opt-in (see
// VITE_REQUIRE_AUTH in .env.example and router/index.ts's guard), so the
// rest of the app must keep working even before Supabase Auth is set up at
// all — every caller here (api.ts, useAuth.ts, router guard) treats
// `supabase === null` the same as "no session."

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
