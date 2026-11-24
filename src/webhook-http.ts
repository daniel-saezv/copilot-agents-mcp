import { lookup } from "node:dns/promises";
import * as https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { webhookPayloadId } from "./delivery.ts";
import type { TaskNotice } from "./state.ts";

export type WebhookAddress = { address: string; family: number };
export type WebhookResolver = (hostname: string) => Promise<WebhookAddress[]>;
export type ValidatedWebhookUrl = { url: URL; addresses: WebhookAddress[] };

const INVALID_URL = "Webhook URL must resolve exclusively to public HTTPS addresses.";
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
  try {
    const url = new URL(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || !hostname
      || hostname.toLowerCase().replace(/\.$/, "") === "metadata.google.internal") {
      throw new Error(INVALID_URL);
    }
    const allowed = env.COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS;
    if (allowed !== undefined && !allowed.split(",").some((host) => host.trim().toLowerCase() === hostname.toLowerCase())) {
      throw new Error(INVALID_URL);
    }
    const family = isIP(hostname);
    const addresses = family ? [{ address: hostname, family }] : await resolver(hostname);
    if (!addresses.length || addresses.some(({ address, family: resolvedFamily }) => (
      !publicAddress(address) || isIP(address) !== resolvedFamily
    ))) throw new Error(INVALID_URL);
    return { url, addresses };
  } catch {
    throw new Error(INVALID_URL);
  }
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
    const body = JSON.stringify({
      task_id: notice.task_id,
      state: notice.state,
      repo: notice.repo,
      pr_url: notice.pull_request?.html_url ?? null,
    });
    await new Promise<void>((resolve, reject) => {
      const request = https.request(url, {
        method: "POST",
        agent: false,
        lookup: pinnedLookup,
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? "" : url.hostname,
        headers: {
          Host: url.host,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: authorization,
          "Idempotency-Key": webhookPayloadId(notice.task_id, notice.state),
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
