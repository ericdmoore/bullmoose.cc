/**
 * Auth stub. Production auth is OIDC bearer tokens + app passwords
 * (services/auth); for the MVP a single dev token maps to a single
 * dev account so the JMAP surface can be exercised end-to-end.
 */

export interface AccountAccess {
  accountId: string;
  tenantId: string;
  name: string;
}

export interface Principal {
  username: string;
  accounts: AccountAccess[];
}

export interface AuthEnv {
  DEV_BEARER_TOKEN?: string;
  DEV_ACCOUNT_ID: string;
  DEV_TENANT_ID: string;
  DEV_USERNAME: string;
}

export function authenticate(request: Request, env: AuthEnv): Principal | null {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !env.DEV_BEARER_TOKEN || token !== env.DEV_BEARER_TOKEN) return null;

  return {
    username: env.DEV_USERNAME,
    accounts: [
      { accountId: env.DEV_ACCOUNT_ID, tenantId: env.DEV_TENANT_ID, name: env.DEV_USERNAME },
    ],
  };
}

export function accountAccess(principal: Principal, accountId: string): AccountAccess | null {
  return principal.accounts.find((a) => a.accountId === accountId) ?? null;
}
