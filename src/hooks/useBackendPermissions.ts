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

export function useBackendPermissions() {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    return subscribeBackendSessionChange(() => {
      setVersion((previous) => previous + 1);
    });
  }, []);

  return useMemo(
    () => ({
      version,
      authenticated: isBackendAuthenticated(),
      permissions: getBackendPermissions(),
      canAccessFeature,
      canUseCloudProvider,
      canUseLlmProvider,
      canAccessRoutePath,
      getAuthorizedSettingsTabs,
      getFirstAuthorizedRoute,
    }),
    [version]
  );
}
