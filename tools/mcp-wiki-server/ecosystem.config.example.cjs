const { join } = require("node:path");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const wikiDir = required("WIKI_DIR");
const bunBin = process.env.BUN_BIN?.trim() || "bun";
const server = join(wikiDir, "tools", "mcp-wiki-server", "http-server.ts");

module.exports = {
  apps: [
    {
      name: process.env.MCP_PUBLIC_PROCESS_NAME || "llm-wiki-mcp-public",
      cwd: wikiDir,
      script: bunBin,
      args: ["run", server],
      interpreter: "none",
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 5000,
      env: {
        WIKI_DIR: wikiDir,
        WIKI_FTS_DB: required("WIKI_FTS_DB"),
        MCP_SCOPE: "public",
        MCP_HTTP_HOST: process.env.MCP_PUBLIC_HOST || "127.0.0.1",
        MCP_HTTP_PORT: process.env.MCP_PUBLIC_PORT || "9320",
        MCP_HTTP_PATH: process.env.MCP_HTTP_PATH || "/mcp",
        MCP_ALLOWED_HOSTS: required("MCP_PUBLIC_ALLOWED_HOSTS"),
        ...(process.env.MCP_BEARER_TOKEN ? { MCP_BEARER_TOKEN: process.env.MCP_BEARER_TOKEN } : {}),
      },
    },
    {
      name: process.env.MCP_ADMIN_PROCESS_NAME || "llm-wiki-mcp-admin",
      cwd: wikiDir,
      script: bunBin,
      args: ["run", server],
      interpreter: "none",
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 5000,
      env: {
        WIKI_DIR: wikiDir,
        WIKI_FTS_DB: required("WIKI_FTS_DB"),
        MCP_SCOPE: "admin",
        MCP_HTTP_HOST: process.env.MCP_ADMIN_HOST || "127.0.0.1",
        MCP_HTTP_PORT: process.env.MCP_ADMIN_PORT || "9321",
        MCP_HTTP_PATH: process.env.MCP_HTTP_PATH || "/mcp",
        MCP_ALLOWED_HOSTS: required("MCP_ADMIN_ALLOWED_HOSTS"),
        MCP_OAUTH_ISSUER: required("MCP_OAUTH_ISSUER"),
        MCP_OAUTH_RESOURCE: required("MCP_OAUTH_RESOURCE"),
        MCP_OAUTH_DB: required("MCP_OAUTH_DB"),
        MCP_OAUTH_OWNER_USERNAME: required("MCP_OAUTH_OWNER_USERNAME"),
        MCP_OAUTH_PASSWORD_HASH_FILE: required("MCP_OAUTH_PASSWORD_HASH_FILE"),
        MCP_OAUTH_PRIVATE_KEY_FILE: required("MCP_OAUTH_PRIVATE_KEY_FILE"),
        MCP_OAUTH_PUBLIC_KEY_FILE: required("MCP_OAUTH_PUBLIC_KEY_FILE"),
        MCP_OAUTH_SCOPES: process.env.MCP_OAUTH_SCOPES || "mcp:admin",
      },
    },
  ],
};
