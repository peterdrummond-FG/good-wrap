// Service layer over user_integrations (db/schema.ts) — the only place that
// reads/writes that table, so encryption and refresh-on-demand logic can't
// drift between call sites (routes/integrations.ts, asana.ts's per-user
// fallback in queries.ts, etc.).

import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/client";
import { encryptToken, decryptToken } from "../../util/tokenCrypto";
import { providerRegistry, type IntegrationProviderName } from "./providerRegistry";
import type { OAuthAccountIdentity, OAuthTokenResult } from "./types";

// Refresh a bit before actual expiry so a request never races a token that
// expires mid-flight.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface IntegrationStatus {
  provider: IntegrationProviderName;
  connected: boolean;
  accountEmail: string | null;
  connectedAt: string | null;
}

export async function listConnections(userId: string): Promise<IntegrationStatus[]> {
  const rows = await db
    .select({
      provider: schema.userIntegrations.provider,
      providerAccountEmail: schema.userIntegrations.providerAccountEmail,
      createdAt: schema.userIntegrations.createdAt,
    })
    .from(schema.userIntegrations)
    .where(eq(schema.userIntegrations.userId, userId));

  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return (Object.keys(providerRegistry) as IntegrationProviderName[]).map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected: Boolean(row),
      accountEmail: row?.providerAccountEmail ?? null,
      connectedAt: row?.createdAt?.toISOString() ?? null,
    };
  });
}

export async function saveConnection(
  userId: string,
  provider: IntegrationProviderName,
  tokens: OAuthTokenResult,
  identity: OAuthAccountIdentity
): Promise<void> {
  const expiresAt = tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000) : null;

  await db
    .insert(schema.userIntegrations)
    .values({
      userId,
      provider,
      providerAccountId: identity.accountId,
      providerAccountEmail: identity.accountEmail,
      accessTokenCiphertext: encryptToken(tokens.accessToken),
      refreshTokenCiphertext: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      scope: tokens.scope,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [schema.userIntegrations.userId, schema.userIntegrations.provider],
      set: {
        providerAccountId: identity.accountId,
        providerAccountEmail: identity.accountEmail,
        accessTokenCiphertext: encryptToken(tokens.accessToken),
        refreshTokenCiphertext: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
        scope: tokens.scope,
        expiresAt,
        updatedAt: new Date(),
      },
    });
}

export async function disconnect(userId: string, provider: IntegrationProviderName): Promise<boolean> {
  const rows = await db
    .delete(schema.userIntegrations)
    .where(and(eq(schema.userIntegrations.userId, userId), eq(schema.userIntegrations.provider, provider)))
    .returning({ id: schema.userIntegrations.id });
  return rows.length > 0;
}

/** Returns a live, ready-to-use access token for this user+provider,
 * transparently refreshing it first if it's near expiry. Returns null if
 * the user hasn't connected this provider at all. */
export async function getValidAccessToken(
  userId: string,
  provider: IntegrationProviderName
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(schema.userIntegrations)
    .where(and(eq(schema.userIntegrations.userId, userId), eq(schema.userIntegrations.provider, provider)))
    .limit(1);
  if (!row) return null;

  const nearExpiry = row.expiresAt ? row.expiresAt.getTime() - REFRESH_SKEW_MS < Date.now() : false;
  if (!nearExpiry || !row.refreshTokenCiphertext) {
    return decryptToken(row.accessTokenCiphertext);
  }

  const refreshed = await providerRegistry[provider].refreshAccessToken(decryptToken(row.refreshTokenCiphertext));
  const expiresAt = refreshed.expiresInSeconds ? new Date(Date.now() + refreshed.expiresInSeconds * 1000) : null;
  await db
    .update(schema.userIntegrations)
    .set({
      accessTokenCiphertext: encryptToken(refreshed.accessToken),
      refreshTokenCiphertext: refreshed.refreshToken ? encryptToken(refreshed.refreshToken) : row.refreshTokenCiphertext,
      expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(schema.userIntegrations.id, row.id));

  return refreshed.accessToken;
}
