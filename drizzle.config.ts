import { defineConfig } from "drizzle-kit";

// Reads DATABASE_URL from the environment (Supabase connection string —
// Project Settings > Database > Connection string > URI. Use the "Transaction"
// pooler string for serverless/edge, or the direct connection string for
// migrations run from a persistent environment).
//
// In practice every schema change so far (see Supabase's own migration
// history, not `db/migrations/` — that folder has never been populated) has
// been applied directly against the live DB via the Supabase MCP's
// apply_migration tool, one hand-written incremental SQL statement per
// change, with db/schema.ts updated by hand to match. `db:generate`/
// `db:migrate` are wired up here but unused — `db:generate` would emit a
// from-scratch migration (it has no prior migration files to diff against),
// which does not match reality and would fail if run against this DB.
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
