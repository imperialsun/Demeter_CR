import { type LlmApiProvider } from "@/store/asr-store";
import { hasBackendPermission, isBackendAuthenticated } from "@/lib/backend-session";
import { isBackendMode } from "@/lib/runtime-config";

export type FeaturePermission =
  | "feature.localupload"
  | "feature.cloudupload"
  | "feature.assistant"
  | "feature.llmlocal"
  | "feature.llmapi"
  | "feature.settings"
  | "feature.telemetry";

export type AppRoute =
  | "/localupload"
  | "/cloudupload"
  | "/assistant"
  | "/llmlocal"
  | "/llmapi"
  | "/settings"
  | "/telemetry"
  | "/forbidden";

export type CloudProviderId = "whisper" | "mistral" | "demeter_sante";

export type SettingsTabId = "local" | "cloud" | "llmlocal" | "llm";

const FEATURE_ROUTE_ORDER: Array<{ route: Exclude<AppRoute, "/forbidden">; feature: FeaturePermission }> = [
  { route: "/localupload", feature: "feature.localupload" },
  { route: "/cloudupload", feature: "feature.cloudupload" },
  { route: "/assistant", feature: "feature.assistant" },
  { route: "/llmlocal", feature: "feature.llmlocal" },
  { route: "/llmapi", feature: "feature.llmapi" },
  { route: "/settings", feature: "feature.settings" },
  { route: "/telemetry", feature: "feature.telemetry" },
];

const ROUTE_FEATURE_MAP: Record<string, FeaturePermission> = FEATURE_ROUTE_ORDER.reduce<Record<string, FeaturePermission>>(
  (acc, item) => {
    acc[item.route] = item.feature;
    return acc;
  },
  {
    "/upload": "feature.localupload",
    "/mic": "feature.localupload",
  }
);

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
  for (const item of FEATURE_ROUTE_ORDER) {
    if (canAccessFeature(item.feature)) {
      return item.route;
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
