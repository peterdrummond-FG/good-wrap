// Shared Postgres/Drizzle client, used by both the Stage 0 CLI and (later) the
// Stage 2 processing pipeline and any backend service. Talks to Supabase via a
// plain Postgres connection string — no Supabase client library, no Supabase
// Auth involved, per the "Supabase as Postgres only" decision in the brief.

// Loads .env into process.env. This must happen before anything below reads
// process.env.DATABASE_URL — every CLI/server entrypoint in this project
// imports this file early (directly or transitively), so loading dotenv
// here, first, is enough to cover all of them without repeating it
// everywhere. Having a `.env` file is not enough on its own; something has
// to actually read it in — this is that something.
import "dotenv/config";

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../db/schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill in your " +
      "Supabase connection string (Project Settings > Database > Connection " +
      "string > URI — use the Transaction pooler string for serverless use, " +
      "or the direct connection string for long-running scripts like this CLI)."
  );
}

// `prepare: false` is required when using Supabase's transaction pooler
// (pgbouncer in transaction mode doesn't support prepared statements).
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };

// Exposed so short-lived scripts (like the Stage 0 CLI) can close the
// connection cleanly instead of hanging on an open socket after they finish.
export async function closeDb() {
  await client.end();
}
