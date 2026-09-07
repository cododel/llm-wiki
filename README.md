# LLM Wiki

A portable Markdown knowledge-base template for human-agent collaboration. It combines a source-preserving content contract, deterministic quality checks, local full-text search, a readonly MCP server, and an optional Hermes factcheck workflow.

The repository starts as an empty wiki. Personal knowledge, source-vault history, credentials, runtime databases, and deployment state are intentionally absent.

## Prerequisites

- [Bun](https://bun.sh/) at the version recorded in `.bun-version`.
- Git for history-aware factcheck selection and normal repository workflows.
- [ripgrep](https://github.com/BurntSushi/ripgrep) for `wiki_regex_search`.
- Optional: Hermes plus GNU `timeout` (`gtimeout` from coreutils on macOS) for factchecking.
- Optional: PM2 and an HTTPS reverse proxy for persistent remote MCP.

Do not install dependencies into the wiki. MCP dependencies are exact-pinned in `tools/mcp-wiki-server/package.json` and `bun.lock`; the test harness installs them only in an OS temporary directory, while runtime imports use Bun's global cache.

## Start a wiki

1. Create a repository from this template or copy the selected files without source history.
2. Define the owner's domain in `SCHEMA.md` and deliberately adapt the neutral tag taxonomy.
3. Copy the appropriate file from `templates/` into its canonical content layer and replace every placeholder.
4. Add curated pages to `index.md`, append authorized material changes to `log.md`, and run:

```sh
bun run tools/verify.ts
```

The content lifecycle is documented in `pages/workflows.md`. The synthetic `examples/demo-wiki/` demonstrates raw source → dated readout → durable concept without becoming part of the live wiki index.

## Safety defaults

- Public MCP access requires an exact, unambiguous `visibility: public` on each served page.
- `admin` expands readonly visibility; it never grants MCP writes.
- Remote admin HTTP fails closed unless the complete OAuth configuration is present.
- Factchecking, scheduling, commits, pushes, and deployment are never enabled by initialization.
- Runtime databases, credentials, editor state, and local settings stay outside Git.

## Select another vault

All tools use one root contract:

```sh
WIKI_DIR=<wiki-root> bun run <repo-root>/tools/wiki_health.ts --strict
WIKI_DIR=<wiki-root> WIKI_FTS_DB=<state-dir>/wiki-fts.sqlite \
  bun run <repo-root>/tools/fts5/wiki-search.ts build
```

`WIKI_DIR` defaults to the checkout containing the tools, not the caller's current directory. `WIKI_FTS_DB` defaults inside the selected wiki for convenience; use an external state directory when the vault is mounted readonly.

## Search

```sh
bun run tools/fts5/wiki-search.ts build
bun run tools/fts5/wiki-search.ts search "source provenance" --limit 8
bun run tools/fts5/wiki-search.ts search "workflow" --mode broad --json
```

See `tools/fts5/README.md` for CLI modes, filters, index lifecycle, and privacy properties.

## Local MCP

The stdio server exposes eleven readonly tools for search, exact regex evidence, page/section reads, provenance, link relationships, resolution, catalog access, structural summaries, and publication auditing.

```jsonc
{
  "mcpServers": {
    "llm-wiki": {
      "command": "bun",
      "args": ["run", "<repo-root>/tools/mcp-wiki-server/server.ts"],
      "env": { "WIKI_DIR": "<wiki-root>", "MCP_SCOPE": "admin" }
    }
  }
}
```

Local stdio `admin` trusts the invoking local process. Use `public` for a client that should see only explicitly published pages. Full tool and environment documentation is in `tools/mcp-wiki-server/README.md`.

## Remote MCP with OAuth

The HTTP server is stateless per MCP request. A public endpoint can be open or protected by an optional static Bearer token. An admin endpoint requires the integrated single-owner OAuth service; a static token cannot bypass it.

1. Copy `.env.example` into untracked operator configuration and fill canonical HTTPS URLs, loopback addresses, owner name, and external state/key paths.
2. Generate an Ed25519 signing keypair and an Argon2id owner-password hash. Store them with owner-only permissions outside the repository.
3. Copy and adapt `tools/mcp-wiki-server/ecosystem.config.example.cjs` and `examples/deployment/Caddyfile.example`.
4. Start public/admin processes only after reviewing the exposure with:

```sh
bun run tools/mcp-wiki-server/audit-visibility.ts --list
```

The template does not install PM2, configure DNS/TLS, start processes, or publish a page.

## Optional Hermes factcheck

Factcheck is a bounded, resumable integration, not a prerequisite for the wiki:

```sh
FACTCHECK_FULL=1 bun run tools/factcheck/factcheck-trigger.ts
bun run tools/factcheck/factcheck-trigger.ts
```

Configure the Hermes binary, profile, skill, and timeout command through environment variables. Generated readouts remain in the working tree by default. Set `FACTCHECK_AUTO_COMMIT=1` only when that Git side effect is explicitly desired. No scheduler or external wrapper is included. See `tools/factcheck/README.md`.

## Verification

`bun run tools/verify.ts` runs standalone tool tests, isolated MCP/OAuth tests, strict checks for the empty and demonstration vaults, foreign-working-directory probes, FTS search, visibility assertions, and package-leakage checks. It must leave the repository without `node_modules` or derived SQLite state.

The GitHub Actions workflow runs the same entrypoint and then proves that verification did not rewrite tracked files.
