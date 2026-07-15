// Stage 4 API entrypoint.
//
// Usage:
//   npm run api

import { buildApp } from "./app";

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  const app = buildApp();
  // 0.0.0.0 (not 127.0.0.1) so the process is reachable from outside the
  // container when deployed to a host like Railway — localhost-only binding
  // works fine for local dev but leaves the app unreachable in prod.
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("API server failed to start:", err);
  process.exitCode = 1;
});
