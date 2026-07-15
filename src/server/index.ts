// Stage 4 API entrypoint.
//
// Usage:
//   npm run api

import { buildApp } from "./app";

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  const app = buildApp();
  await app.listen({ port: PORT, host: "127.0.0.1" });
}

main().catch((err) => {
  console.error("API server failed to start:", err);
  process.exitCode = 1;
});
