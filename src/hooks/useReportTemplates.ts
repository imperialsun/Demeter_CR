import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchUserReportTemplates,
  saveUserReportTemplatePreference,
  type UserReportTemplatePreference,
} from "@/lib/report-templates";
import logger from "@/lib/logger";

export function useReportTemplates() {
  const [items, setItems] = useState<UserReportTemplatePreference[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchUserReportTemplates();
      setItems(next);
    } catch (reason) {
      const nextError = reason instanceof Error ? reason : new Error(String(reason));
      setError(nextError);
      logger.warn("[report-templates] load failed", { message: nextError.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setPreference = useCallback(async (templateId: string, enabled: boolean) => {
    const previous = items;
    setItems((current) =>
      current.map((item) => (item.template.id === templateId ? { ...item, enabled } : item))
    );
    try {
      const saved = await saveUserReportTemplatePreference(templateId, enabled);
      setItems((current) =>
        current.map((item) => (item.template.id === templateId ? saved : item))
      );
    } catch (reason) {
      setItems(previous);
      throw reason;
    }
  }, [items]);

  const enabledTemplates = useMemo(
    () => items.filter((item) => item.enabled).map((item) => item.template),
    [items]
  );

  return { items, enabledTemplates, loading, error, refresh, setPreference };
}
