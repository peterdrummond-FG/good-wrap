// Zoom per-user OAuth (authorization-code + PKCE) — a separate "User-managed
// OAuth" Marketplace app from the existing Server-to-Server app in
// src/integrations/zoom.ts, which stays account-wide and backs the
// recording-completed webhook. This one is what lets an individual person
// connect their own Zoom account (Account page's Integrations tab).

import { requireEnv } from "../../util/env";
import type { IntegrationProvider } from "./types";

const AUTHORIZE_URL = "https://zoom.us/oauth/authorize";
const TOKEN_URL = "https://zoom.us/oauth/token";

function basicAuthHeader(): string {
  const clientId = requireEnv("ZOOM_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("ZOOM_OAUTH_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export const zoomOAuthProvider: IntegrationProvider = {
  buildAuthorizeUrl({ state, codeChallenge, redirectUri }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", requireEnv("ZOOM_OAUTH_CLIENT_ID"));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Zoom OAuth code exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresInSeconds: json.expires_in,
      scope: json.scope,
    };
  },

  async refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Zoom OAuth token refresh failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresInSeconds: json.expires_in,
      scope: json.scope,
    };
  },

  async fetchAccountIdentity(accessToken) {
    const res = await fetch("https://api.zoom.us/v2/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Zoom profile lookup failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { id?: string; email?: string };
    return { accountId: json.id, accountEmail: json.email };
  },
};
