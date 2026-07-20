// Per-user Zoom & Asana "Connect account" OAuth — powers the Account page's
// Integrations tab. Two route groups, registered separately from app.ts
// because they need different auth:
//   - registerIntegrationsRoutes: list/authorize/disconnect, needs a signed-in
//     user (registered inside app.ts's requireAuth-hooked scope).
//   - registerIntegrationCallbackRoute: the OAuth provider's own redirect
//     target — carries no bearer token, so it authenticates via the signed
//     `state` param instead (see src/util/oauthState.ts). Registered directly
//     on the root app, outside the requireAuth hook.
//
// See src/integrations/oauth/ for the provider implementations and token
// store, and src/integrations/{zoom,asana}.ts for how this coexists with
// the account-wide Zoom S2S app and the legacy Asana PAT.

import type { FastifyInstance } from "fastify";
import { requireEnv } from "../../util/env";
import { generatePkceVerifier, derivePkceChallenge, signState, verifyState } from "../../util/oauthState";
import { providerRegistry, isIntegrationProviderName } from "../../integrations/oauth/providerRegistry";
import { listConnections, saveConnection, disconnect } from "../../integrations/oauth/tokenStore";
import { createWorkerKey } from "./workerKeys";
import { generateSetupScript, sanitizeLabelSuffix } from "../generateSetupScript";

function redirectUriFor(provider: string): string {
  return `${requireEnv("GOODWRAP_API_BASE_URL")}/api/integrations/${provider}/callback`;
}

export function registerIntegrationsRoutes(app: FastifyInstance): void {
  app.get("/api/integrations", async (req, reply) => {
    const connections = await listConnections(req.currentUser!.id);
    return reply.send({ connections });
  });

  app.get<{ Params: { provider: string } }>("/api/integrations/:provider/authorize", async (req, reply) => {
    const { provider } = req.params;
    if (!isIntegrationProviderName(provider)) {
      return reply.code(400).send({ error: `Unknown provider "${provider}".` });
    }

    const pkceVerifier = generatePkceVerifier();
    const state = signState({ userId: req.currentUser!.id, provider, pkceVerifier });
    const authorizeUrl = providerRegistry[provider].buildAuthorizeUrl({
      state,
      codeChallenge: derivePkceChallenge(pkceVerifier),
      redirectUri: redirectUriFor(provider),
    });
    return reply.send({ authorizeUrl });
  });

  app.delete<{ Params: { provider: string } }>("/api/integrations/:provider", async (req, reply) => {
    const { provider } = req.params;
    if (!isIntegrationProviderName(provider)) {
      return reply.code(400).send({ error: `Unknown provider "${provider}".` });
    }
    await disconnect(req.currentUser!.id, provider);
    return reply.code(204).send();
  });

  // Account page's "Generate setup script" action (Local Setup tab) — issues
  // a fresh personal worker key behind the scenes and bakes it straight into
  // a downloadable, personalized .command file (see generateSetupScript.ts).
  // Re-running this later (new machine, new folder) is just clicking the
  // same button again — each call issues a brand new key.
  app.post("/api/integrations/setup-script", async (req, reply) => {
    const { workerKey } = await createWorkerKey(req.currentUser!.id, "Local watch-folder setup");
    const contents = generateSetupScript({
      workerKey,
      apiBaseUrl: requireEnv("GOODWRAP_API_BASE_URL"),
      labelSuffix: sanitizeLabelSuffix(req.currentUser!.email),
    });
    return reply.send({ filename: "goodwrap-setup.command", contents });
  });
}

export function registerIntegrationCallbackRoute(app: FastifyInstance): void {
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/integrations/:provider/callback",
    async (req, reply) => {
      const dashboardBaseUrl = requireEnv("DASHBOARD_BASE_URL");
      const { provider: providerParam } = req.params;
      const { code, state: rawState, error } = req.query;

      if (!isIntegrationProviderName(providerParam) || error || !code) {
        return reply.redirect(`${dashboardBaseUrl}/account?connectError=${encodeURIComponent(providerParam)}`);
      }

      const state = verifyState(rawState);
      if (!state || state.provider !== providerParam) {
        return reply.redirect(`${dashboardBaseUrl}/account?connectError=${encodeURIComponent(providerParam)}`);
      }

      try {
        const provider = providerRegistry[providerParam];
        const tokens = await provider.exchangeCode({
          code,
          codeVerifier: state.pkceVerifier,
          redirectUri: redirectUriFor(providerParam),
        });
        const identity = await provider.fetchAccountIdentity(tokens.accessToken);
        await saveConnection(state.userId, providerParam, tokens, identity);
      } catch (err) {
        req.log.error(err, `OAuth callback failed for provider ${providerParam}`);
        return reply.redirect(`${dashboardBaseUrl}/account?connectError=${encodeURIComponent(providerParam)}`);
      }

      return reply.redirect(`${dashboardBaseUrl}/account?connected=${encodeURIComponent(providerParam)}`);
    }
  );
}
