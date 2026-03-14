import { randomUUID } from "node:crypto";
import { TestCookieJar } from "@/test/backend/cookieJar";
import { ensureBackendHarness, getBootstrapAdminCredentials } from "@/test/backend/harness";

type AdminAuthResponse = {
  organization: {
    id: string;
  };
  csrfToken: string;
};

type AdminSession = {
  csrfToken: string;
  organizationId: string;
  jar: TestCookieJar;
};

declare global {
  var __demeterBackendAdminSessionPromise: Promise<AdminSession> | undefined;
}

export async function getAdminSession(): Promise<AdminSession> {
  globalThis.__demeterBackendAdminSessionPromise ??= loginBootstrapAdmin();
  return globalThis.__demeterBackendAdminSessionPromise;
}

export async function createBackendUser(options?: {
  email?: string;
  password?: string;
  status?: "active" | "inactive";
}) {
  const session = await getAdminSession();
  const harness = await ensureBackendHarness();
  const email = options?.email ?? uniqueEmail("integration-user");
  const password = options?.password ?? uniquePassword();
  const status = options?.status ?? "active";

  const response = await session.jar.fetch(
    `${harness.baseUrl}/api/v1/admin/organizations/${session.organizationId}/users`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-CSRF": session.csrfToken,
      },
      body: JSON.stringify({ email, password, status }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to create backend user: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    id: string;
    organizationId: string;
    email: string;
    status: string;
  };

  return {
    ...payload,
    password,
  };
}

export async function updateUserEntitlements(
  userId: string,
  overrides: Array<{ permissionCode: string; effect: "allow" | "deny" }>
) {
  const session = await getAdminSession();
  const harness = await ensureBackendHarness();
  const response = await session.jar.fetch(`${harness.baseUrl}/api/v1/admin/users/${userId}/entitlements`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-CSRF": session.csrfToken,
    },
    body: JSON.stringify({ overrides }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update entitlements: ${response.status} ${await response.text()}`);
  }
}

export async function getUserAccess(userId: string) {
  const session = await getAdminSession();
  const harness = await ensureBackendHarness();
  const response = await session.jar.fetch(`${harness.baseUrl}/api/v1/admin/users/${userId}/access`);
  if (!response.ok) {
    throw new Error(`Failed to fetch user access: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    effectivePermissions: string[];
    globalRoles: string[];
    orgRoles: string[];
  };
}

export async function getActivitySummary(query?: { from?: string; to?: string }) {
  const session = await getAdminSession();
  const harness = await ensureBackendHarness();
  const url = new URL(`${harness.baseUrl}/api/v1/admin/activity/summary`);
  if (query?.from) {
    url.searchParams.set("from", query.from);
  }
  if (query?.to) {
    url.searchParams.set("to", query.to);
  }

  const response = await session.jar.fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch activity summary: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    totals: {
      transcriptions: number;
      reports: number;
    };
    breakdown: {
      reportsByMode: Record<string, number>;
      reportsByProvider: Record<string, number>;
    };
  };
}

export function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID()}@example.test`;
}

export function uniquePassword() {
  return `Pw-${randomUUID()}-Aa1!`;
}

async function loginBootstrapAdmin(): Promise<AdminSession> {
  const harness = await ensureBackendHarness();
  const jar = new TestCookieJar(globalThis.__demeterNativeFetch ?? globalThis.fetch.bind(globalThis));
  const credentials = getBootstrapAdminCredentials();

  const response = await jar.fetch(`${harness.baseUrl}/api/v1/admin/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(credentials),
  });

  if (!response.ok) {
    throw new Error(`Failed to login bootstrap admin: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as AdminAuthResponse;
  return {
    csrfToken: payload.csrfToken,
    organizationId: payload.organization.id,
    jar,
  };
}
