import { type LlmApiProvider } from "@/store/asr-store";
import { hasBackendPermission, isBackendAuthenticated } from "@/lib/backend-session";
import { isBackendMode } from "@/lib/runtime-config";
import { AUTHORIZED_ROUTE_ORDER, type AuthorizedRoute } from "@/lib/authorized-route-order";

export type FeaturePermission =
  | "feature.localupload"
  | "feature.cloudupload"
  | "feature.assistant"
  | "feature.llmlocal"
  | "feature.llmapi"
  | "feature.settings"
  | "feature.telemetry";

export type AppRoute = AuthorizedRoute | "/forbidden";

export type CloudProviderId = "whisper" | "mistral" | "demeter_sante";

export type SettingsTabId = "local" | "cloud" | "llmlocal" | "llm";

const ROUTE_FEATURE_MAP: Record<string, FeaturePermission> = {
  "/assistant": "feature.assistant",
  "/localupload": "feature.localupload",
  "/cloudupload": "feature.cloudupload",
  "/llmlocal": "feature.llmlocal",
  "/llmapi": "feature.llmapi",
  "/settings": "feature.settings",
  "/telemetry": "feature.telemetry",
  "/upload": "feature.localupload",
  "/mic": "feature.localupload",
};

const CLOUD_PROVIDER_PERMISSION_MAP: Record<CloudProviderId, string> = {
  whisper: "provider.cloud.whisper",
  mistral: "provider.cloud.mistral",
  demeter_sante: "provider.cloud.demeter_sante",
};

const LLM_PROVIDER_PERMISSION_MAP: Record<LlmApiProvider, string> = {
  huggingface: "provider.llm.huggingface",
  mistral: "provider.llm.mistral",
  demeter_sante: "provider.llm.demeter_sante",
};

const SETTINGS_TAB_FEATURE_MAP: Array<{ tab: SettingsTabId; feature: FeaturePermission }> = [
  { tab: "local", feature: "feature.localupload" },
  { tab: "cloud", feature: "feature.cloudupload" },
  { tab: "llmlocal", feature: "feature.llmlocal" },
  { tab: "llm", feature: "feature.llmapi" },
];

function hasPermission(code: string): boolean {
  if (!isBackendMode()) return true;
  if (!isBackendAuthenticated()) return false;
  return hasBackendPermission(code);
}

export function canAccessFeature(feature: FeaturePermission): boolean {
  if (feature === "feature.assistant") {
    return isBackendMode() && hasPermission(CLOUD_PROVIDER_PERMISSION_MAP.demeter_sante);
  }
  return hasPermission(feature);
}

export function canUseCloudProvider(provider: CloudProviderId): boolean {
  return hasPermission(CLOUD_PROVIDER_PERMISSION_MAP[provider]);
}

export function canUseLlmProvider(provider: LlmApiProvider): boolean {
  return hasPermission(LLM_PROVIDER_PERMISSION_MAP[provider]);
}

export function getFirstAuthorizedRoute(): AppRoute {
  if (!isBackendMode()) return "/localupload";
  for (const route of AUTHORIZED_ROUTE_ORDER) {
    if (canAccessRoutePath(route)) {
      return route;
    }
  }
  return "/forbidden";
}

export function getRouteFeature(pathname: string): FeaturePermission | null {
  return ROUTE_FEATURE_MAP[pathname] ?? null;
}

export function canAccessRoutePath(pathname: string): boolean {
  const feature = getRouteFeature(pathname);
  if (!feature) return true;
  return canAccessFeature(feature);
}

export function getAuthorizedSettingsTabs(): SettingsTabId[] {
  if (!isBackendMode()) {
    return ["local", "cloud", "llmlocal", "llm"];
  }

  return SETTINGS_TAB_FEATURE_MAP.filter((item) => canAccessFeature(item.feature)).map((item) => item.tab);
}

export function isSettingsTabAuthorized(tab: SettingsTabId): boolean {
  return getAuthorizedSettingsTabs().includes(tab);
}
