import { defineConfig } from "drizzle-kit";

// Reads DATABASE_URL from the environment (Supabase connection string —
// Project Settings > Database > Connection string > URI. Use the "Transaction"
// pooler string for serverless/edge, or the direct connection string for
// migrations run from a persistent environment).
// Not run yet — this just wires up `drizzle-kit generate` / `drizzle-kit migrate`
// for when Peter confirms the schema and is ready to create the DB.
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
