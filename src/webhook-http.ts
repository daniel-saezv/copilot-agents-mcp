import { lookup } from "node:dns/promises";
import * as https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { webhookPayloadId } from "./delivery.ts";
import type { TaskNotice } from "./state.ts";

export type WebhookAddress = { address: string; family: number };
export type WebhookResolver = (hostname: string) => Promise<WebhookAddress[]>;
export type ValidatedWebhookUrl = { url: URL; addresses: WebhookAddress[] };

const VALIDATION_ERRORS = {
  input: "Invalid webhook URL. Provide an absolute URL without embedded credentials.",
  https: "Webhook URL must use HTTPS. Change the URL scheme to https.",
  nonPublic: "Webhook URL resolves to a non-public address. Use a host whose addresses are all public.",
  allowedHost: "Webhook host is outside COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS. Use an allowed host or update that setting.",
  dns: "Webhook DNS lookup failed. Check the hostname and DNS configuration, then retry.",
} as const;

export class WebhookValidationError extends Error {
  constructor(reason: keyof typeof VALIDATION_ERRORS) {
    super(VALIDATION_ERRORS[reason]);
    this.name = "WebhookValidationError";
  }
}
const DELIVERY_FAILED = "Webhook delivery failed.";
const TIMEOUT_MS = 10_000;

function publicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a = 0, b = 0, c = 0] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

function ipv6Value(address: string): bigint {
  const expanded = address.replace(/\d+\.\d+\.\d+\.\d+$/, (ipv4) => {
    const octets = ipv4.split(".").map(Number);
    return `${((octets[0] ?? 0) * 256 + (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) * 256 + (octets[3] ?? 0)).toString(16)}`;
  });
  const [left = "", right] = expanded.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const value = ipv6Value(address);
  if (value >> 32n === 0xffffn) {
    const ipv4 = [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
    return publicIpv4(ipv4);
  }
  // Only global unicast; exclude documentation and transition ranges.
  return value >> 125n === 1n
    && value >> 96n !== 0x20010db8n
    && value >> 96n !== 0x20010000n
    && value >> 80n !== 0x200100020000n
    && value >> 100n !== 0x2001001n
    && value >> 100n !== 0x2001002n
    && value >> 108n !== 0x3fff0n
    && value >> 112n !== 0x2002n;
}

const resolveWebhook: WebhookResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function validateWebhookUrl(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  resolver: WebhookResolver = resolveWebhook,
): Promise<ValidatedWebhookUrl> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebhookValidationError("input");
  }
  if (url.protocol !== "https:") throw new WebhookValidationError("https");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.username || url.password || !hostname) throw new WebhookValidationError("input");
  if (hostname.toLowerCase().replace(/\.$/, "") === "metadata.google.internal") {
    throw new WebhookValidationError("nonPublic");
  }
  const allowed = env.COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS;
  if (allowed !== undefined && !allowed.split(",").some((host) => host.trim().toLowerCase() === hostname.toLowerCase())) {
    throw new WebhookValidationError("allowedHost");
  }
  const family = isIP(hostname);
  let addresses: WebhookAddress[];
  try {
    addresses = family ? [{ address: hostname, family }] : await resolver(hostname);
  } catch {
    throw new WebhookValidationError("dns");
  }
  if (!addresses.length) throw new WebhookValidationError("dns");
  if (addresses.some(({ address, family: resolvedFamily }) => (
    !publicAddress(address) || isIP(address) !== resolvedFamily
  ))) throw new WebhookValidationError("nonPublic");
  return { url, addresses };
}

export function webhookPost(notice: TaskNotice, authorization: string | undefined): { body: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": webhookPayloadId(notice.task_id, notice.state),
  };
  if (authorization) headers.Authorization = authorization;
  return {
    body: JSON.stringify({
      task_id: notice.task_id,
      state: notice.state,
      repo: notice.repo,
      pr_url: notice.pull_request?.html_url ?? null,
    }),
    headers,
  };
}

export async function postOwnerNotice(
  input: string,
  notice: TaskNotice,
  authorization: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const { url, addresses } = await validateWebhookUrl(input, env);
    const [pinned] = addresses as [WebhookAddress, ...WebhookAddress[]];
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    const { body, headers } = webhookPost(notice, authorization);
    await new Promise<void>((resolve, reject) => {
      const request = https.request(url, {
        method: "POST",
        agent: false,
        lookup: pinnedLookup,
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? "" : url.hostname,
        headers: {
          ...headers,
          Host: url.host,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
      }, (response) => {
        response.on("error", () => reject(new Error(DELIVERY_FAILED)));
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(DELIVERY_FAILED));
      });
      const timer = setTimeout(() => request.destroy(new Error(DELIVERY_FAILED)), TIMEOUT_MS);
      request.on("close", () => clearTimeout(timer));
      request.on("error", () => {
        clearTimeout(timer);
        reject(new Error(DELIVERY_FAILED));
      });
      request.on("timeout", () => request.destroy(new Error(DELIVERY_FAILED)));
      request.end(body);
    });
  } catch {
    throw new Error(DELIVERY_FAILED);
  }
}
