import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
import { updateIndex } from "../fts5/wiki-search.ts";
import { CONFIG, type Scope } from "./config.ts";
import { createOAuthService } from "./oauth.ts";
import { buildServer } from "./server.ts";
import type { ToolCtx } from "./tools.ts";

/** Static Bearer gate is only available to the optional public endpoint. */
export function bearerAuthorized(headers: Headers, token?: string): boolean {
  if (!token) return true;
  const supplied = Buffer.from(headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
export type OAuthRequestAuth = { clientId: string; subject: string; scopes: string[]; expiresAt: number };
export type OAuthHttpGate = {
  handleRoute(request: Request): Promise<Response | undefined>;
  authorizeRequest(request: Request): Promise<OAuthRequestAuth | Response>;
};
export type HttpHandlerOptions = { path: string; bearerToken?: string; allowedHosts?: string[]; oauth?: OAuthHttpGate };
export type OAuthRuntimeConfig = {
  issuer: string; resource: string; dbPath: string; ownerUsername: string;
  passwordHashFile: string; privateKeyFile: string; publicKeyFile: string; requiredScopes: string[];
};
export type HttpRuntimeConfig = { host: string; port: number; path: string; bearerToken?: string; allowedHosts: string[]; oauth?: OAuthRuntimeConfig };
export function parseHttpRuntimeConfig(env: Record<string, string | undefined>, scope: Scope): HttpRuntimeConfig {
  const host = env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = Number(env.MCP_HTTP_PORT ?? "9320"); const path = env.MCP_HTTP_PATH ?? "/mcp";
  const bearerToken = scope === "public" ? env.MCP_BEARER_TOKEN || undefined : undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_HTTP_PORT must be 1..65535");
  if (!path.startsWith("/")) throw new Error("MCP_HTTP_PATH must start with /");
  const required = (name: string): string => {
    const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required for admin OAuth`); return value;
  };
  const oauth = scope === "admin" ? {
    issuer: required("MCP_OAUTH_ISSUER"), resource: required("MCP_OAUTH_RESOURCE"), dbPath: required("MCP_OAUTH_DB"),
    ownerUsername: required("MCP_OAUTH_OWNER_USERNAME"), passwordHashFile: required("MCP_OAUTH_PASSWORD_HASH_FILE"),
    privateKeyFile: required("MCP_OAUTH_PRIVATE_KEY_FILE"), publicKeyFile: required("MCP_OAUTH_PUBLIC_KEY_FILE"),
    requiredScopes: (env.MCP_OAUTH_SCOPES ?? "mcp:admin").split(/\s+/).filter(Boolean),
  } : undefined;
  const allowedHosts = (env.MCP_ALLOWED_HOSTS ?? `${host}:${port},${host},localhost:${port},localhost`).split(",").map((v) => v.trim()).filter(Boolean);
  return { host, port, path, bearerToken, allowedHosts, oauth };
}
export function createHttpHandler(ctx: ToolCtx, options: HttpHandlerOptions) {
  if (ctx.scope === "admin" && !options.oauth) throw new Error("Admin HTTP requires OAuth; static tokens cannot bypass it");
  return async (request: Request): Promise<Response> => {
    const oauthResponse = await options.oauth?.handleRoute(request);
    if (oauthResponse) return oauthResponse;
    if (new URL(request.url).pathname !== options.path) return new Response("Not Found", { status: 404 });
    if (options.oauth) {
      const auth = await options.oauth.authorizeRequest(request); if (auth instanceof Response) return auth;
    } else if (!bearerAuthorized(request.headers, options.bearerToken)) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } });
    }
    try {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
        ...(options.allowedHosts?.length ? { allowedHosts: options.allowedHosts, enableDnsRebindingProtection: true } : {}) });
      const server = buildServer(ctx); await server.connect(transport);
      const response = await transport.handleRequest(request);
      const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error("[llm-wiki-http] request failed", error);
      return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
        { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
async function main(): Promise<void> {
  const runtime = parseHttpRuntimeConfig(process.env, CONFIG.scope);
  const ctx: ToolCtx = { wikiDir: CONFIG.wikiDir, dbPath: CONFIG.dbPath, scope: CONFIG.scope };
  updateIndex({ wikiDir: ctx.wikiDir, dbPath: ctx.dbPath, quiet: true });
  const oauth = runtime.oauth ? createOAuthService({ issuer: runtime.oauth.issuer, resource: runtime.oauth.resource,
    dbPath: runtime.oauth.dbPath, ownerUsername: runtime.oauth.ownerUsername,
    ownerPasswordHash: readFileSync(runtime.oauth.passwordHashFile, "utf8").trim(),
    privateKeyPem: readFileSync(runtime.oauth.privateKeyFile, "utf8"), publicKeyPem: readFileSync(runtime.oauth.publicKeyFile, "utf8"),
    requiredScopes: runtime.oauth.requiredScopes }) : undefined;
  const fetch = createHttpHandler(ctx, { path: runtime.path, bearerToken: runtime.bearerToken, allowedHosts: runtime.allowedHosts, oauth });
  Bun.serve({ hostname: runtime.host, port: runtime.port, fetch });
  console.error(`[llm-wiki-http] ready scope=${ctx.scope} auth=${oauth ? "oauth" : runtime.bearerToken ? "bearer" : "open"} url=http://${runtime.host}:${runtime.port}${runtime.path}`);
}
if (import.meta.main) main().catch((error) => { console.error("[llm-wiki-http] fatal", error); process.exit(1); });
