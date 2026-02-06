export type CloudInferenceDefaults = {
  apiUrl: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  doSample: boolean;
};

export type CloudInferenceSession = {
  apiUrl?: string | null;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  doSample?: boolean | null;
};

export type CloudInferenceResolved = CloudInferenceDefaults & {
  sources: {
    apiUrl: "settings" | "session";
    maxTokens: "settings" | "session";
    temperature: "settings" | "session";
    topP: "settings" | "session";
    doSample: "settings" | "session";
  };
};

const isFiniteNumber = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value);

export function resolveCloudSessionSettings(
  defaults: CloudInferenceDefaults,
  session: CloudInferenceSession
): CloudInferenceResolved {
  const trimmedUrl = session.apiUrl?.trim();
  const apiUrl = trimmedUrl ? trimmedUrl : defaults.apiUrl;
  const maxTokens = isFiniteNumber(session.maxTokens) ? session.maxTokens! : defaults.maxTokens;
  const temperature = isFiniteNumber(session.temperature) ? session.temperature! : defaults.temperature;
  const topP = isFiniteNumber(session.topP) ? session.topP! : defaults.topP;
  const doSample = typeof session.doSample === "boolean" ? session.doSample : defaults.doSample;

  return {
    apiUrl,
    maxTokens,
    temperature,
    topP,
    doSample,
    sources: {
      apiUrl: trimmedUrl ? "session" : "settings",
      maxTokens: isFiniteNumber(session.maxTokens) ? "session" : "settings",
      temperature: isFiniteNumber(session.temperature) ? "session" : "settings",
      topP: isFiniteNumber(session.topP) ? "session" : "settings",
      doSample: typeof session.doSample === "boolean" ? "session" : "settings",
    },
  };
}
