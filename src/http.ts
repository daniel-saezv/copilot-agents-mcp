import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { selectionFromHttp, type Selection } from "./selection.ts";
import { buildServer, type ServerDeps } from "./server.ts";

export async function startHttpServer(options: {
  port: number;
  selection: Selection;
  deps: ServerDeps;
}): Promise<{ url: string; host: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(req, res, options.selection, options.deps);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not open the HTTP port.");
  return {
    url: `http://${address.address}:${address.port}/mcp`,
    host: address.address,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, base: Selection, deps: ServerDeps): Promise<void> {
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method not allowed.");
    return;
  }
  let selection: Selection;
  try {
    selection = selectionFromHttp(req.url ?? "/", headersOf(req), base);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(message);
    return;
  }
  let mcp: McpServer;
  try {
    mcp = buildServer(selection, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(message);
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("MCP server error.");
    }
  }
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}
