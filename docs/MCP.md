# MCP v2

Transport: Streamable HTTP at `/mcp`, JSON responses, strict input/output schemas. The server
advertises version `2.0.0`; tool payloads use `{version:2,data}` or `{version:2,error}`. Errors have
`code`, safe `message` and HTTP-style `status`; failed tools set `isError`. Discover exact schemas
with `tools/list`. Unknown fields, vault paths and old response layouts are not silently accepted.

Authorize using the pre-registered personal client (Authorization Code + S256 PKCE + refresh) or
optional factchecker (client credentials). Both request `resource=https://<wiki-host>/mcp`.
Personal scopes are `wiki:read wiki:write wiki:factcheck`; machine scopes are
`wiki:read wiki:factcheck`. Scopes do not substitute for local identity grants. Browser publication
uses another client with `wiki:owner`; it cannot be performed by calling an MCP approval tool.

## Reading

| Tool | Purpose |
|---|---|
| `wiki_search` | RU/EN FTS, auto/strict/broad, type/tag filters, bounded ranked excerpts |
| `wiki_search_and_read` | Search followed by authorized snapshots |
| `wiki_regex_search` | Bounded ripgrep syntax, exact line evidence; no lookaround/backreferences |
| `wiki_get_page` | Stable ID, optional exact revision and unique heading |
| `wiki_get_related` | Incoming/outgoing typed relations |
| `wiki_resolve` | ID/slug/title resolution with explicit ambiguity |
| `wiki_list` | Filtered, paginated authorized catalog |
| `wiki_get_sources` | Provenance, reverse processed_to and original hash |
| `wiki_health_summary` | Structural and original-integrity diagnostics |
| `wiki_lint_summary` | Layer-aware editorial warnings |
| `wiki_audit_visibility` | Explicit published revision/attachment counts |

`wiki_tags` supplies counts/show/suggest/validate against authorized content. Suggest is a
deterministic context packet. Search rank is PostgreSQL FTS rank, not old SQLite BM25 or a
calibrated confidence. Regex inspects at most 500 authorized snapshots / 5 MB for two seconds,
returning at most 100 matches. No persistent file copy is created. Heading selection returns
the selected body fragment; revision/hash still identify the complete immutable snapshot.

## Atomic writing and sources

`wiki_apply_change` accepts an actor-scoped `idempotency_key` and up to 50 operations:
`create`, `edit`, `source`, `archive`, `tag`. Choose a UUID for new records. Edit/archive require
the current `expected_revision`. A source operation uses nullable expected revision, exact
`original_base64` and SHA-256 checksum. Raw metadata includes source kind/channel/capture boundary.
The response returns accepted IDs/revisions. Reuse the exact key/payload after an uncertain response.

Documents contain title, slug, Markdown body, typed metadata, taxonomy tags, typed relations,
source revision/URL references and attachment hashes. Server timestamps/reverse provenance are
not client-maintained fields. See [SCHEMA](../SCHEMA.md) for semantic distinctions.

`wiki_ingest_attachment` accepts bounded original bytes, declared PNG/JPEG/PDF type and checksum.
Only reference the returned hash after successful intake. New raw revision IDs are returned by
source acceptance; use those exact IDs in subsequent processed provenance. No automatic URL fetch.

`wiki_request_publication` fixes an ID, revision and selected attachments. The owner opens
`/publications` after `/auth/login`. `wiki_unpublish` withdraws public access without deleting
history. `status: published` has no access effect.

## Agent assignments

1. Call `wiki_factcheck_next`, or `wiki_review_start` then `wiki_review_next`; alternatively receive
   a signed webhook for the same assignment.
2. Read `wiki_assignment_get` if needed. Follow the versioned workflow and supplied result schema.
3. Call `wiki_assignment_claim`. A task ID alone is not a reservation. On conflict do not research it.
4. Persist intermediate work with `wiki_assignment_progress` before lease expiry.
5. Submit exact snapshot-bound claims through `wiki_assignment_complete`, or report a technical
   failure through `wiki_assignment_fail`. Retain claim token for idempotent completion retries.

`wiki_assignment_result` returns the complete structured evidence behind a bounded generated
readout. `wiki_review_summary` derives campaign progress/totals from stored results. No agent edits the
checked content or writes its own checkpoint/readout/index. UTF-16 claim offsets refer to the
complete pinned body, not a heading excerpt. Webhook HTTP acknowledgement does not complete work.

`wiki_events_list`, `wiki_event_acknowledge` and `wiki_event_resolve` expose durable escalation to
the personal agent. They remain available when notification delivery fails. See the
[workflow contract](FACTCHECK_CONTRACT.md) for lifecycle and semantic limits.
