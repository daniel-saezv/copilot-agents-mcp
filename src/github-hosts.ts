export function githubApiBase(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.COPILOT_AGENTS_GITHUB_API_BASE_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("COPILOT_AGENTS_GITHUB_API_BASE_URL is not a valid URL.");
  }
  const host = url.hostname;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("COPILOT_AGENTS_GITHUB_API_BASE_URL must use https unless the host is loopback.");
  }
  return raw.replace(/\/$/, "");
}

export function githubWebHost(env: NodeJS.ProcessEnv = process.env): string {
  const api = githubApiBase(env);
  if (!api) return "github.com";
  const url = new URL(api);
  const host = url.hostname.toLowerCase();
  if (host === "api.github.com") return "github.com";
  if (host.startsWith("api.") && host.endsWith(".ghe.com")) return host.slice("api.".length);
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/api/v3" || path.endsWith("/api/v3")) return host;
  if (host.startsWith("api.")) return host.slice("api.".length);
  return host;
}

function isApiStyleUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (host.startsWith("api.")) return true;
  if (path.startsWith("/api/") || path.startsWith("/api/v3/")) return true;
  if (path.startsWith("/repos/")) return true;
  return false;
}

export function githubPageUrl(url: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname.toLowerCase() !== githubWebHost(env)) return undefined;
    if (isApiStyleUrl(parsed)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}