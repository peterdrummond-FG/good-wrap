// Shared entrypoint wrapper for every Stage N CLI (ingest/cli.ts,
// pipeline/cli.ts, pipeline/fullCli.ts, notify/cli.ts, qa/cli.ts): runs
// `main`, reports a failure consistently (including an Error's `.cause`
// chain, if any), and always closes the DB connection afterward so these
// short-lived scripts don't hang on an open socket once they finish.

import { closeDb } from "../db/client";

export function runCli(label: string, main: () => Promise<void>): void {
  main()
    .catch((err) => {
      console.error(`${label} failed:`, err.message ?? err);
      if (err.cause) console.error("Caused by:", err.cause.message ?? err.cause);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
