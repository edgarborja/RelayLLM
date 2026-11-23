/**
 * Provider endpoints are fixed by the worker owner in local config. Remote
 * clients can never choose a destination. By default only loopback hosts are
 * allowed so a misconfiguration can't turn the worker into a LAN proxy.
 */

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_NAMES.has(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export interface EndpointCheck {
  ok: boolean;
  url?: URL;
  reason?: string;
}

/**
 * Validate a provider base URL, e.g. "http://localhost:1234/v1".
 * Returns a normalized URL without trailing slash, query or fragment.
 */
export function checkProviderEndpoint(raw: string, opts: { allowRemote?: boolean } = {}): EndpointCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "must be http or https" };
  if (u.username || u.password) return { ok: false, reason: "credentials must not be embedded in the URL" };
  if (!opts.allowRemote && !isLoopbackHost(u.hostname)) {
    return {
      ok: false,
      reason: `host "${u.hostname}" is not loopback; set provider.allowRemoteEndpoint=true to allow it`,
    };
  }
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "");
  return { ok: true, url: u };
}
