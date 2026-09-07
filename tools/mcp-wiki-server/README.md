# MCP Wiki Server

Readonly MCP over one selected LLM Wiki. Local clients use stdio; remote clients use stateless Streamable HTTP. Every result passes through the same path-safety, visibility, and redaction boundary.

## Runtime

- Bun uses the exact direct dependencies in `package.json` and `bun.lock` through dynamic runtime imports and its global cache.
- `rg` provides bounded Rust-regex search; look-around and backreferences are unsupported.
- `WIKI_DIR` selects the vault and defaults to the tool checkout root.
- `WIKI_FTS_DB` selects disposable private FTS state and defaults to `<WIKI_DIR>/.wiki-fts5.db`.
- No project-local install is supported; use `bun run tools/mcp-wiki-server/test.ts` for an isolated OS-temp install and test run.

## Readonly tools

| Tool | Purpose |
|---|---|
| `wiki_search` | BM25-ranked gated search. |
| `wiki_regex_search` | Exact gated line evidence through `rg`. |
| `wiki_search_and_read` | Search plus bounded page excerpts. |
| `wiki_get_page` | Full or section-bounded page read. |
| `wiki_get_related` | Confirmed inbound/outbound wikilink relationships. |
| `wiki_resolve` | Canonical source-aware wikilink resolution. |
| `wiki_list` | Filtered, sorted, paginated visible-page catalog. |
| `wiki_get_sources` | Raw/external provenance and `processed_to`. |
| `wiki_health_summary` | Structural health counts. |
| `wiki_lint_summary` | Layer-aware lint counts. |
| `wiki_audit_visibility` | Exact public exposure inventory. |

The FTS database may contain private text. Search results are authorized after retrieval, before snippets or ambiguity candidates are returned. Do not serve the SQLite file directly.

## Visibility and path safety

Public access denies every page unless frontmatter contains exactly one valid `visibility: public`. Folder, type, and lifecycle status never publish content. Admin can read permitted private Markdown but remains readonly.

Both scopes deny operational/packaging layers, archives, dependencies, runtime files, non-Markdown files, traversal, absolute targets, NUL bytes, and symlink escapes. Secret redaction is defense in depth, not permission to publish unreviewed material.

## Local stdio

```sh
WIKI_DIR=<wiki-root> MCP_SCOPE=admin \
  bun run <repo-root>/tools/mcp-wiki-server/server.ts
```

Any `MCP_SCOPE` value other than literal `admin` becomes `public`.

## HTTP configuration

| Variable | Default | Purpose |
|---|---|---|
| `MCP_SCOPE` | `public` | `public` or readonly `admin`. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address; keep loopback behind a reverse proxy. |
| `MCP_HTTP_PORT` | `9320` | Backend port. |
| `MCP_HTTP_PATH` | `/mcp` | Exact MCP route. |
| `MCP_ALLOWED_HOSTS` | loopback values | DNS-rebinding Host allowlist. |
| `MCP_BEARER_TOKEN` | unset | Optional public-only static Bearer token. |
| `MCP_OAUTH_ISSUER` | required for admin | Canonical HTTPS authorization-server issuer. |
| `MCP_OAUTH_RESOURCE` | required for admin | Exact canonical admin MCP audience. |
| `MCP_OAUTH_DB` | required for admin | OAuth SQLite outside the repository. |
| `MCP_OAUTH_OWNER_USERNAME` | required for admin | Single owner login. |
| `MCP_OAUTH_PASSWORD_HASH_FILE` | required for admin | Argon2id hash file outside the repository. |
| `MCP_OAUTH_PRIVATE_KEY_FILE` | required for admin | Ed25519 private key outside the repository. |
| `MCP_OAUTH_PUBLIC_KEY_FILE` | required for admin | Ed25519 public key outside the repository. |
| `MCP_OAUTH_SCOPES` | `mcp:admin` | Required space-separated scopes. |

Admin startup fails if any required OAuth value or file is absent; `MCP_BEARER_TOKEN` is ignored and cannot bypass OAuth. The integrated service supports discovery, public-client registration, explicit consent, Authorization Code with PKCE S256, scoped Ed25519 access JWTs, rotating refresh-token families, revocation, and bounded/rate-limited transient state.

Keep OAuth state, key material, and the password hash in an owner-only external directory. Generate an Ed25519 keypair with an operator-reviewed cryptographic tool and an Argon2id password hash with Bun's password API or an equivalent trusted utility; set every state/secret file to mode `0600` before startup.

Use `.env.example`, `ecosystem.config.example.cjs`, and `examples/deployment/Caddyfile.example` as inputs, not ready-to-deploy configuration. Review `audit-visibility.ts --list` before exposing either endpoint.

## Verification

```sh
bun run tools/mcp-wiki-server/test.ts
```

The harness covers all eleven tools, stdio and HTTP framing, public/private non-leakage, traversal/symlink defense, OAuth discovery/consent/PKCE/JWT/refresh/revocation, and absence of vault-local dependencies.
