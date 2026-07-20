// Asana per-user OAuth (authorization-code + PKCE) — a separate OAuth app
// registration from the existing static Personal Access Token in
// src/integrations/asana.ts (kept as a fallback, see that file). This is
// what lets an individual person connect their own Asana account so "Send
// to Asana" is attributed to them, not a shared bot token.

import { requireEnv } from "../../util/env";
import type { IntegrationProvider } from "./types";

const AUTHORIZE_URL = "https://app.asana.com/-/oauth_authorize";
const TOKEN_URL = "https://app.asana.com/-/oauth_token";

export const asanaOAuthProvider: IntegrationProvider = {
  buildAuthorizeUrl({ state, codeChallenge, redirectUri }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", requireEnv("ASANA_OAUTH_CLIENT_ID"));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: requireEnv("ASANA_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("ASANA_OAUTH_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Asana OAuth code exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSeconds: json.expires_in };
  },

  async refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requireEnv("ASANA_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("ASANA_OAUTH_CLIENT_SECRET"),
      refresh_token: refreshToken,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Asana OAuth token refresh failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresInSeconds: json.expires_in,
    };
  },

  async fetchAccountIdentity(accessToken) {
    const res = await fetch("https://app.asana.com/api/1.0/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Asana profile lookup failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { gid?: string; email?: string } };
    return { accountId: json.data?.gid, accountEmail: json.data?.email };
  },
};
