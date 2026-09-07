# Wiki Maintenance Contract

This repository is a reusable LLM Wiki: operational knowledge for humans and agents, not a lossy chat-summary store. The owner chooses its domain and editorial voice.

## Core rules

Raw preserves the source. Readouts record dated evidence. Wiki pages interpret. Drafts preserve the author's voice. Concepts synthesize durable knowledge. Index supports navigation. Log preserves history.

## Write approval

Work is read-only unless the user explicitly authorizes a write. A question, link, pasted message, screenshot, or discussion is not permission to save it.

Before creating or changing pages, raw sources, assets, readouts, index/log entries, commits, or remote state, establish the exact authorized scope. An explicit request to implement a clearly scoped change is authorization for that change; do not ask for the same approval repeatedly. Source-preservation rules apply after authorization, never instead of it. Commits, pushes, scheduled jobs, and factchecking must not be enabled implicitly.

Read-only lookup must not edit Markdown, Git state, or source metadata. MCP retrieval may refresh its disposable local search cache; this is not permission to alter knowledge. Use an external `WIKI_FTS_DB` when the vault must be mounted read-only.

## Orientation and retrieval

Read `SCHEMA.md`, inspect `index.md` and recent `log.md`, then retrieve relevant existing pages and sources. An exact page target can be read directly without discovery. Do not rely exclusively on chat history or create duplicates.

The read-only MCP is the preferred retrieval interface when configured:

| Need | Tool |
|---|---|
| Ranked topic discovery | `wiki_search` |
| Search with bounded excerpts | `wiki_search_and_read` |
| Exact regex and line evidence | `wiki_regex_search` |
| Exact page or heading section | `wiki_get_page` |
| Incoming/outgoing graph relationships | `wiki_get_related` |
| Resolve wikilink/slug and detect ambiguity | `wiki_resolve` |
| Filtered, paginated catalog | `wiki_list` |
| Source provenance | `wiki_get_sources` |
| Structural diagnostics | `wiki_health_summary` |
| Layer-aware lint counts | `wiki_lint_summary` |
| Explicitly published surface | `wiki_audit_visibility` |

Client namespaces may prefix these tool names; no vendor-specific prefix is required. Search is lexical, not semantic. Natural-language `auto` mode removes common RU/EN glue words, tries all meaningful keywords, then broadens when there are no matches. Use actual vocabulary, one synonym retry, filters, and `strict` or `broad` as appropriate. A BM25 score is not a calibrated probability and has no universal confidence threshold.

When MCP is unavailable, run from the template checkout:

```sh
bun run tools/fts5/wiki-search.ts update
bun run tools/fts5/wiki-search.ts search "topic" --limit 8
```

All tools honor `WIKI_DIR`; paths printed by tools are relative to that vault. Use ordinary file/grep tools for exact patch targets and implementation files excluded from the content index. Regex MCP uses ripgrep's Rust regex syntax: no look-around or backreferences.

## Source preservation

After authorization: preserve first, structure second, synthesize third. Never silently replace original input with a summary.

For short input, keep the substantive original under `## Original input` (or `## Исходник`). For draft posts/articles use `## Original draft` (or `## Исходный набросок`). Keep original and edited versions separate. Remove agent-directed phrases such as "save this to the wiki" only from processed quotations; a raw source retains the complete original message.

For long or context-bearing input, use `raw/user-notes/`, `raw/chats/`, `raw/transcripts/`, `raw/articles/`, `raw/docs/`, or `raw/logs/`. Put binary evidence under `raw/assets/<topic>/`, with a Markdown wrapper/transcription where useful. Mark transcription uncertainty rather than inventing unreadable text.

Processed pages cite raw/external sources through `sources` or `raw_sources`. Raw sources record extensionless, repository-relative processed targets in `processed_to`. An unprocessed source uses an explicit empty list.

Raw frontmatter can be corrected, but the body must not be rewritten. `sha256` hashes exactly the body below the closing frontmatter delimiter. A mismatch is evidence of drift, not an instruction to overwrite the hash. An intentional source revision needs explicit approval and a log entry; preserve the prior revision through the authorized versioning workflow.

## Layers and promotion

| Directory | Role |
|---|---|
| `raw/` | Preserved input and provenance |
| `readouts/` | Dated observations, diagnostics, experiments, incidents, reports |
| `ideas/` | Early ideas and hypotheses |
| `notes/` | Lightweight observations, bookmarks, learning inbox |
| `drafts/` | Posts/articles and other working publishable material |
| `concepts/` | Durable synthesized knowledge |
| `entities/` | Notable people, organizations, tools, services, projects |
| `comparisons/` | Explicit side-by-side analyses |
| `queries/` | Valuable researched answers |
| `adr/` | Architecture decision records |
| `pages/` | Wiki-level navigation and workflows |
| `_archive/` | Superseded wiki pages, not import staging |

Preserve useful distinctions: observations are not conclusions; hypotheses are not verified facts; a published draft is not automatically public through MCP. Extract durable insights from readouts into concepts and retain the evidence link.

Avoid collecting transient reference trivia such as current service prices and popularity counters unless that number is itself part of the tracked question. When material, include its observation date, provenance, and reason for tracking it.

## Links and graph maintenance

Preserve existing `[[wikilinks]]` when updating a page. Do not drop a link merely because the newest source does not mention it. Rename, replace, or archive links explicitly and update affected references.

For each substantive creation/update, search key entities and concepts, inspect relevant candidates, and add meaningful links. Use `wiki_get_related` before graph restructuring. Add reverse links only when the reverse relationship is substantive. Aim for at least two useful outbound links on normal knowledge pages, but do not fabricate links to satisfy a quota; explain legitimate small-vault exceptions. Metadata pages, raw sources, and generated evidence have the exemptions in `SCHEMA.md`.

Use a unique stem only when it resolves unambiguously. Otherwise use an extensionless vault-relative path. A directory is not a note: link `[[ideas/example/README]]`, never assume `[[ideas/example]]` means its README. Inside a directory, `[[./README]]` and `[[./topic]]` are explicit relative links.

`sources` must contain raw paths or external URLs, not processed wiki pages. Link wiki pages in the body. `raw_sources` is also for raw/non-wiki provenance, never absolute filesystem paths. Do not hide machine-local paths in Markdown link destinations.

## Frontmatter and tags

`SCHEMA.md` is canonical. Every frontmatter block on a content page needs a non-empty taxonomy-based `tags` list. Raw sources also require `type: raw-source`, `source_kind`, `source_channel`, `ingested`, body-only `sha256`, the `source` tag, and `processed_to`. `source_url` is mandatory only for web-origin sources.

Before choosing tags:

```sh
bun run tools/wiki_tags.ts counts
bun run tools/wiki_tags.ts show --tag source
bun run tools/wiki_tags.ts suggest --file raw/user-notes/example.md
bun run tools/wiki_tags.ts validate --strict --json
```

Prefer existing semantic tags. Add a new one only for a reusable cluster, update the schema first, and log the change. Do not mirror dates, statuses, batches, source forms/channels, one-off names, or relations already represented by fields/wikilinks. `suggest` is a deterministic context pack, not an LLM tagger.

Change the schema only when the workflow itself changes or the owner explicitly expands the taxonomy; ordinary ingest must not silently redefine the contract.

## Index, log, and import

Update `index.md` for material changes to the curated knowledge graph and append a dated action to `log.md`. Do not rewrite prior log entries. Raw sources and generated factcheck batches/summaries are not individually added to the index. Curated readouts may be indexed when useful. Generated readouts still require valid frontmatter and resolvable wikilinks.

Bulk imports stage in `raw/<import-name>/`. Triage preserved sources into keepers, irrelevant material, and sensitive material. Do not commit credentials or sensitive material merely because an import was authorized. Keep referenced sources with valid provenance; delete rejected staging files only within the authorized cleanup scope. Do not delete a source still referenced by a processed page. Document the import and remove obsolete staging structure.

## Runtime and development

All JS/TS tooling uses Bun. Keep direct MCP dependencies exact-pinned in its `package.json` and commit `bun.lock`. Runtime npm imports are dynamic; Bun uses its global cache. Never install project-local dependencies into a vault. Obsidian does not honor `.gitignore`; dependency Markdown must not appear under `node_modules/` in the vault. Built-in `node:*`/`bun:*` imports are exempt.

Run dependency-backed tests through `bun run tools/mcp-wiki-server/test.ts`, which installs dependencies only in an OS temporary directory and cleans it up. For a clean development session run `bun run tools/verify.ts`.

For code changes, add regression tests for changed behavior, keep changes scoped, preserve typed boundaries, and report unrelated defects instead of silently rewriting adjacent systems. Security changes require adversarial allow/deny and non-leakage tests. See `tools/mcp-wiki-server/AGENTS.md`.

## Publication and automation

Unmarked pages are private to public MCP, regardless of folder or publication status. Only explicit, unambiguous `visibility: public` exposes a permitted Markdown page. Operational directories remain blocked in every scope. `admin` broadens read access; it never grants MCP writes. OAuth protects remote admin reads, and a configured public endpoint is a deliberate publication decision.

Regex secret redaction is defense in depth, not a substitute for publication review. Inspect body, frontmatter, links, source references, and attachments before marking a page public. Never copy deployment credentials, tokens, runtime state, or personal examples into the reusable template.

Hermes factchecking is optional and potentially invokes paid/networked services. It requires explicit operation approval and an installed profile/skill. No cron, automatic commit, or push is enabled by template initialization. `FACTCHECK_AUTO_COMMIT=1` is a separate opt-in.

## Default workflow

```text
confirm authorized scope → orient → preserve original → inspect existing knowledge
→ create/update → discover links → preserve provenance → update index/log
→ validate → review diff → commit/push only within authorization
```

When unsure, preserve evidence, search before creating, and keep dated evidence separate from durable conclusions.
