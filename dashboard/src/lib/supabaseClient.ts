// Supabase Auth client — used ONLY for authentication (Google/Microsoft SSO
// session issuance), not as a database client. The dashboard still talks to
// good-wrap's own Fastify API (see ../api.ts) for all data; this just
// supplies the bearer token that API now requires (see src/server/auth.ts).

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (build-time env vars) — see .env.example."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
