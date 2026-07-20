import { zoomOAuthProvider } from "./zoomOAuthProvider";
import { asanaOAuthProvider } from "./asanaOAuthProvider";
import type { IntegrationProvider } from "./types";

export type IntegrationProviderName = "zoom" | "asana";

export const providerRegistry: Record<IntegrationProviderName, IntegrationProvider> = {
  zoom: zoomOAuthProvider,
  asana: asanaOAuthProvider,
};

export function isIntegrationProviderName(value: string): value is IntegrationProviderName {
  return value === "zoom" || value === "asana";
}
