import { expect, test } from "bun:test";
import { bearerAuthorized, createHttpHandler, parseHttpRuntimeConfig } from "./http-server.ts";
import type { ToolCtx } from "./tools.ts";
const ctx: ToolCtx = { wikiDir: "/tmp/unused", dbPath: "/tmp/unused.db", scope: "public" };
test("optional public Bearer gate requires the exact token", () => {
  expect(bearerAuthorized(new Headers(), undefined)).toBe(true);
  expect(bearerAuthorized(new Headers(), "synthetic-token")).toBe(false);
  expect(bearerAuthorized(new Headers({ authorization: "Bearer wrong" }), "synthetic-token")).toBe(false);
  expect(bearerAuthorized(new Headers({ authorization: "Bearer synthetic-token" }), "synthetic-token")).toBe(true);
});
test("admin runtime requires complete OAuth and ignores static token fallback", () => {
  expect(() => parseHttpRuntimeConfig({}, "admin")).toThrow("MCP_OAUTH_ISSUER is required");
  const runtime = parseHttpRuntimeConfig({ MCP_OAUTH_ISSUER: "https://mcp.example.test", MCP_OAUTH_RESOURCE: "https://mcp.example.test/admin/mcp",
    MCP_OAUTH_DB: "/run/wiki/oauth.sqlite", MCP_OAUTH_OWNER_USERNAME: "owner", MCP_OAUTH_PASSWORD_HASH_FILE: "/run/wiki/password.hash",
    MCP_OAUTH_PRIVATE_KEY_FILE: "/run/wiki/private.pem", MCP_OAUTH_PUBLIC_KEY_FILE: "/run/wiki/public.pem", MCP_BEARER_TOKEN: "ignored" }, "admin");
  expect(runtime.oauth).toMatchObject({ issuer: "https://mcp.example.test", resource: "https://mcp.example.test/admin/mcp", requiredScopes: ["mcp:admin"] });
  expect(runtime.bearerToken).toBeUndefined();
  expect(() => createHttpHandler({ ...ctx, scope: "admin" }, { path: "/mcp", bearerToken: "not-a-bypass" })).toThrow("requires OAuth");
});
test("runtime validates port and route path", () => {
  expect(parseHttpRuntimeConfig({}, "public")).toMatchObject({ host: "127.0.0.1", port: 9320, path: "/mcp" });
  for (const port of ["0", "65536", "bad"]) expect(() => parseHttpRuntimeConfig({ MCP_HTTP_PORT: port }, "public")).toThrow();
  expect(() => parseHttpRuntimeConfig({ MCP_HTTP_PATH: "mcp" }, "public")).toThrow();
});
test("HTTP exact path routing returns 404 elsewhere", async () => {
  expect((await createHttpHandler(ctx, { path: "/mcp" })(new Request("http://127.0.0.1/other"))).status).toBe(404);
});
test("OAuth gate runs before MCP protocol parsing", async () => {
  const resourceMetadataUrl = "https://mcp.example.test/.well-known/oauth-protected-resource/admin/mcp";
  const handler = createHttpHandler({ ...ctx, scope: "admin" }, { path: "/mcp", oauth: {
    handleRoute: async () => undefined,
    authorizeRequest: async () => new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:admin"`, "Cache-Control": "no-store" } }),
  } });
  const response = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", body: "invalid protocol" }));
  expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toContain(resourceMetadataUrl); expect(response.headers.get("www-authenticate")).toContain('scope="mcp:admin"');
});
test("OAuth discovery routes are delegated independently of MCP path", async () => {
  const handler = createHttpHandler(ctx, { path: "/mcp", oauth: { handleRoute: async () => Response.json({ issuer: "https://example.test" }), authorizeRequest: async () => { throw new Error("not reached"); } } });
  expect(await (await handler(new Request("http://127.0.0.1/.well-known/oauth-authorization-server"))).json()).toMatchObject({ issuer: "https://example.test" });
});
test("HTTP stateless initialize round trip", async () => {
  const handler = createHttpHandler(ctx, { path: "/mcp", bearerToken: "synthetic-token" });
  const response = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", headers: {
    authorization: "Bearer synthetic-token", accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ result: { serverInfo: { name: "llm-wiki" } } });
});
