export const AUTHORIZED_ROUTE_ORDER = [
  "/assistant",
  "/localupload",
  "/cloudupload",
  "/llmlocal",
  "/llmapi",
  "/settings",
  "/telemetry",
] as const;

export type AuthorizedRoute = (typeof AUTHORIZED_ROUTE_ORDER)[number];
