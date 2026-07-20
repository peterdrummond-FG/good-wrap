// Shared shape for per-user OAuth providers (Zoom, Asana today). Adding a
// third provider later is one new file implementing this interface plus one
// line in providerRegistry.ts — not new plumbing in the routes/token store.

export interface OAuthTokenResult {
  accessToken: string;
  /** Absent for providers/grants that don't issue one. */
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string;
}

export interface OAuthAccountIdentity {
  accountId?: string;
  accountEmail?: string;
}

export interface IntegrationProvider {
  buildAuthorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenResult>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult>;
  fetchAccountIdentity(accessToken: string): Promise<OAuthAccountIdentity>;
}
