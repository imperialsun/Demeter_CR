import { useEffect, useMemo, useState } from "react";

import {
  canAccessFeature,
  canAccessRoutePath,
  canUseCloudProvider,
  canUseLlmProvider,
  getAuthorizedSettingsTabs,
  getFirstAuthorizedRoute,
} from "@/lib/backend-permissions";
import { getBackendPermissions, isBackendAuthenticated, subscribeBackendSessionChange } from "@/lib/backend-session";
import logger from "@/lib/logger";

export function useBackendPermissions() {
  const [version, setVersion] = useState(0);
  const authenticated = isBackendAuthenticated();
  const permissions = getBackendPermissions();
  const authorizedSettingsTabs = getAuthorizedSettingsTabs();
  const firstAuthorizedRoute = getFirstAuthorizedRoute();
  const permissionsKey = permissions.join("|");
  const authorizedTabsKey = authorizedSettingsTabs.join("|");

  useEffect(() => {
    logger.debug("[permissions] hook mounted");
    return subscribeBackendSessionChange(() => {
      logger.info("[permissions] backend session changed");
      setVersion((previous) => previous + 1);
    });
  }, []);

  useEffect(() => {
    logger.debug("[permissions] snapshot resolved", {
      version,
      authenticated,
      permissionCount: permissions.length,
      firstAuthorizedRoute,
      authorizedSettingsTabs,
    });
  }, [authenticated, authorizedSettingsTabs, authorizedTabsKey, firstAuthorizedRoute, permissions.length, permissionsKey, version]);

  return useMemo(
    () => ({
      version,
      authenticated,
      permissions,
      canAccessFeature,
      canUseCloudProvider,
      canUseLlmProvider,
      canAccessRoutePath,
      getAuthorizedSettingsTabs,
      getFirstAuthorizedRoute,
    }),
    [authenticated, permissions, version]
  );
}
