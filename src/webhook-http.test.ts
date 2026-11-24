import { EventEmitter } from "node:events";
import * as https from "node:https";
import type { RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webhookPayloadId } from "./delivery.ts";
import type { TaskNotice } from "./state.ts";
import { postOwnerNotice, validateWebhookUrl } from "./webhook-http.ts";
import type { WebhookAddress } from "./webhook-http.ts";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn<() => Promise<WebhookAddress[]>>() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ request: vi.fn() }));

const invalidUrl = "Webhook URL resolves to a non-public address. Use a host whose addresses are all public.";
const inputError = "Invalid webhook URL. Provide an absolute URL without embedded credentials.";
const httpsError = "Webhook URL must use HTTPS. Change the URL scheme to https.";
const allowedHostError = "Webhook host is outside COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS. Use an allowed host or update that setting.";
const dnsError = "Webhook DNS lookup failed. Check the hostname and DNS configuration, then retry.";
const notice: TaskNotice = {
  task_id: "task-1", state: "completed", repo: "owner/repo",
  requested_model: "model", resolved_model: null, pull_request: null, branch: null,
  artifacts: [], error: "must not be sent", usage: null, created_at: null,
  updated_at: null, completed_at: null, session_id: "session-1", notified: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});

afterEach(() => vi.useRealTimers());

describe("validateWebhookUrl", () => {
  it.each([
    "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1",
    "172.15.255.255", "172.32.0.1", "192.169.0.1",
    "[2606:4700:4700::1111]", "[2001:4860:4860::8888]",
    "[2606:4700:4700:0000:0000:0000:0000:1111]",
    "[::ffff:8.8.8.8]", "[::ffff:808:808]",
  ])("accepts public literal %s without DNS", async (host) => {
    const result = await validateWebhookUrl(`https://${host}/notice`, {});
    expect(result.url.pathname).toBe("/notice");
    expect(result.addresses).toHaveLength(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "127.0.0.1", "100.64.0.0",
    "100.127.255.255", "169.254.169.254", "172.16.0.0", "172.31.255.255",
    "192.168.1.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1",
    "239.1.2.3", "240.0.0.1", "255.255.255.255", "2130706433", "0x7f000001",
    "[::]", "[::1]", "[fc00::1]", "[fd00::1]", "[fd00:ec2::254]", "[fe80::1]", "[ff02::1]",
    "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[::ffff:192.168.1.1]",
    "[::ffff:100.64.0.1]", "[::ffff:169.254.169.254]", "[::ffff:7f00:1]",
    "[::127.0.0.1]", "[2001:db8::1]", "[2001:2::1]", "[2001:10::1]", "[2001:20::1]",
    "[3fff::1]", "[2002:7f00:1::]", "[64:ff9b::7f00:1]",
  ])("rejects non-public literal %s", async (host) => {
    await expect(validateWebhookUrl(`https://${host}/private-secret`, {})).rejects.toThrow(invalidUrl);
  });

  it.each([
    ["http://example.com", httpsError], ["ftp://example.com", httpsError],
    ["not-a-url", inputError], ["https://", inputError],
    ["******example.com/private", inputError], ["https://username@example.com", inputError],
    ["https://metadata.google.internal", invalidUrl], ["https://METADATA.GOOGLE.INTERNAL.", invalidUrl],
    ["https://[fe80::1%25eth0]", inputError],
  ])("rejects unsafe URL %s with an actionable reason", async (url, message) => {
    await expect(validateWebhookUrl(url, {})).rejects.toThrow(message);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("accepts public DNS and returns all validated addresses", async () => {
    const addresses = [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }];
    const resolver = vi.fn().mockResolvedValue(addresses);
    const result = await validateWebhookUrl("https://hooks.example.com/path", {}, resolver);
    expect(result.addresses).toEqual(addresses);
    expect(resolver).toHaveBeenCalledExactlyOnceWith("hooks.example.com");
  });

  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1",
  ])("rejects DNS rebinding to %s even alongside a public address", async (address) => {
    const family = address.includes(":") ? 6 : 4;
    const resolver = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address, family }]);
    await expect(validateWebhookUrl("https://hooks.example.com", {}, resolver)).rejects.toThrow(invalidUrl);
  });

  it.each(([
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:192.168.0.1", family: 6 }],
    [{ address: "8.8.8.8", family: 6 }], [{ address: "not-an-ip", family: 4 }],
  ] satisfies WebhookAddress[][]).map((addresses) => ({ addresses })))("rejects invalid DNS result $addresses", async ({ addresses }) => {
    await expect(validateWebhookUrl("https://hooks.example.com", {}, async () => addresses)).rejects.toThrow(invalidUrl);
  });

  it("reports an empty DNS response as a DNS failure", async () => {
    await expect(validateWebhookUrl("https://hooks.example.com", {}, async () => []))
      .rejects.toThrow(dnsError);
  });

  it("never exposes resolver errors or URL fragments", async () => {
    const resolver = vi.fn().mockRejectedValue(new Error("secret.example.com/private?token=secret"));
    await expect(validateWebhookUrl("https://secret.example.com/private?token=secret", {}, resolver))
      .rejects.toThrow(dnsError);
  });

  it("uses allowed hosts only as an exact narrowing", async () => {
    const env = { COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS: " Hooks.Example.com , other.example.com " };
    await expect(validateWebhookUrl("https://hooks.example.com", env)).resolves.toBeDefined();
    await expect(validateWebhookUrl("https://sub.hooks.example.com", env)).rejects.toThrow(allowedHostError);
    await expect(validateWebhookUrl("https://hooks.example.com.evil.com", env)).rejects.toThrow(allowedHostError);
    await expect(validateWebhookUrl("https://hooks.example.com", { COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS: "" })).rejects.toThrow(allowedHostError);
    await expect(validateWebhookUrl("https://127.0.0.1", { COPILOT_AGENTS_NOTIFY_ALLOWED_HOSTS: "127.0.0.1" })).rejects.toThrow(invalidUrl);
  });
});

function mockPost(statusCode = 204) {
  const request = new EventEmitter();
  const resume = vi.fn();
  const end = vi.fn<(body: string) => void>(() => {
    queueMicrotask(() => {
      const callback = vi.mocked(https.request).mock.calls[0]?.[2] as (response: IncomingMessage) => void;
      callback(Object.assign(new EventEmitter(), { statusCode, resume }) as unknown as IncomingMessage);
      request.emit("close");
    });
  });
  const destroy = vi.fn((error: Error) => {
    request.emit("error", error);
    request.emit("close");
  });
  vi.mocked(https.request).mockReturnValue(Object.assign(request, { end, destroy }) as unknown as ReturnType<typeof https.request>);
  return { request, end, destroy, resume };
}

describe("postOwnerNotice", () => {
  it("posts only the four payload fields with stable headers and the original HTTPS host", async () => {
    const { end, resume } = mockPost();
    const withPr = { ...notice, pull_request: { id: 1, number: 1, html_url: "https://github.com/owner/repo/pull/1" } };
    await postOwnerNotice("https://hooks.example.com:8443/private?token=query-secret", withPr, "******", {});
    const [url, rawOptions] = vi.mocked(https.request).mock.calls[0] ?? [];
    const options = rawOptions as RequestOptions;
    expect(String(url)).toBe("https://hooks.example.com:8443/private?token=query-secret");
    const body = end.mock.calls[0]?.[0];
    expect(body).toBe(JSON.stringify({
      task_id: "task-1", state: "completed", repo: "owner/repo", pr_url: withPr.pull_request.html_url,
    }));
    expect(options).toMatchObject({
      method: "POST", agent: false, timeout: 10_000,
      servername: "hooks.example.com",
      headers: {
        Host: "hooks.example.com:8443",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(String(body)),
        Authorization: "******",
        "Idempotency-Key": webhookPayloadId(notice.task_id, notice.state),
      },
    });
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.servername).not.toBe("8.8.8.8");
    expect(resume).toHaveBeenCalledOnce();
  });

  it("pins the validated address instead of resolving again at connection time", async () => {
    const { end } = mockPost();
    await postOwnerNotice("https://hooks.example.com", notice, "******", {});
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const options = vi.mocked(https.request).mock.calls[0]?.[1] as RequestOptions;
    const callback = vi.fn();
    options.lookup?.("hooks.example.com", {}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, "8.8.8.8", 4);
    const allCallback = vi.fn();
    options.lookup?.("hooks.example.com", { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledExactlyOnceWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(lookup).toHaveBeenCalledOnce();
    expect(JSON.parse(String(end.mock.calls[0]?.[0]))).toEqual({
      task_id: "task-1", state: "completed", repo: "owner/repo", pr_url: null,
    });
    await expect(postOwnerNotice("https://hooks.example.com", notice, "******", {})).rejects.toThrow("Webhook delivery failed.");
    expect(https.request).toHaveBeenCalledOnce();
  });

  it("pins public IPv6 DNS while retaining TLS certificate verification and SNI", async () => {
    lookup.mockResolvedValue([{ address: "2606:4700::1111", family: 6 }]);
    mockPost();
    await postOwnerNotice("https://hooks.example.com", notice, "secret", {});
    const options = vi.mocked(https.request).mock.calls[0]?.[1] as RequestOptions;
    const callback = vi.fn();
    options.lookup?.("hooks.example.com", {}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, "2606:4700::1111", 6);
    expect(options.servername).toBe("hooks.example.com");
    expect(options.rejectUnauthorized).toBeUndefined();
    expect(lookup).toHaveBeenCalledExactlyOnceWith("hooks.example.com", { all: true, verbatim: true });
  });

  it("uses the same idempotency key for repeated delivery of the same task state", async () => {
    mockPost();
    await postOwnerNotice("https://hooks.example.com", notice, "secret", {});
    const firstHeaders = (vi.mocked(https.request).mock.calls[0]?.[1] as RequestOptions).headers;
    vi.mocked(https.request).mockClear();
    mockPost();
    await postOwnerNotice("https://hooks.example.com", { ...notice, session_id: "different-session" }, "secret", {});
    const secondHeaders = (vi.mocked(https.request).mock.calls[0]?.[1] as RequestOptions).headers;
    expect(secondHeaders).toEqual(firstHeaders);
  });

  it.each([301, 302, 303, 307, 308, 400, 500])("rejects HTTP %s without another request", async (statusCode) => {
    mockPost(statusCode);
    await expect(postOwnerNotice("https://hooks.example.com", notice, "secret", {}))
      .rejects.toEqual(new Error("Webhook delivery failed."));
    expect(https.request).toHaveBeenCalledOnce();
  });

  it("rejects mixed private DNS before sending credentials", async () => {
    lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(postOwnerNotice("https://hooks.example.com", notice, "secret", {})).rejects.toThrow("Webhook delivery failed.");
    expect(https.request).not.toHaveBeenCalled();
  });

  it("times out a stalled request after ten seconds without leaking transport errors", async () => {
    vi.useFakeTimers();
    const { end, destroy } = mockPost();
    end.mockImplementation(() => {});
    const result = postOwnerNotice("https://hooks.example.com/private?secret=query", notice, "******", {});
    const assertion = expect(result).rejects.toEqual(new Error("Webhook delivery failed."));
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("sanitizes synchronous request errors", async () => {
    vi.mocked(https.request).mockImplementation(() => { throw new Error("****** private?secret=query"); });
    await expect(postOwnerNotice("https://hooks.example.com/private?secret=query", notice, "******", {}))
      .rejects.toEqual(new Error("Webhook delivery failed."));
  });
});
