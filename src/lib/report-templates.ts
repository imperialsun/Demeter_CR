import { backendFetch, parseBackendJson, throwBackendHttpError } from "@/lib/backend-api";
import type { ReportFormat } from "@/lib/llm/reportSchema";
import logger from "@/lib/logger";

export interface OrganizationReportTemplate {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  baseFormat: ReportFormat;
  instructions: string;
  exampleOutline: string;
  orgEnabled: boolean;
  createdByUserId?: string;
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserReportTemplatePreference {
  template: OrganizationReportTemplate;
  enabled: boolean;
}

export function customReportTemplateKey(templateId: string): `custom:${string}` {
  return `custom:${templateId.trim()}`;
}

export async function fetchUserReportTemplates() {
  logger.debug("[report-templates] loading user templates");
  const response = await backendFetch("/report-templates/");
  if (!response.ok) {
    await throwBackendHttpError(response, "/report-templates/");
  }
  const items = await parseBackendJson<UserReportTemplatePreference[]>(response);
  logger.info("[report-templates] loaded user templates", { count: items.length });
  return items;
}

export async function saveUserReportTemplatePreference(templateId: string, enabled: boolean) {
  const path = `/report-templates/${encodeURIComponent(templateId)}/preference`;
  logger.info("[report-templates] saving user preference", { templateId, enabled });
  const response = await backendFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    await throwBackendHttpError(response, path, "PUT");
  }
  const item = await parseBackendJson<UserReportTemplatePreference>(response);
  logger.info("[report-templates] saved user preference", { templateId, enabled: item.enabled });
  return item;
}
