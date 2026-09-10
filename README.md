# LLM Wiki

A self-hosted knowledge base for humans and AI agents, with preserved sources,
revision history, controlled publication and agent-driven factchecking.

LLM Wiki gives your notes, research, ideas and decisions a durable home outside
individual conversations. Connect a compatible MCP agent to capture material,
retrieve context and develop related knowledge while retaining the evidence behind
it. Original input, dated research findings and interpreted knowledge remain
distinct, so you can revisit how a conclusion was reached.

You operate the service and its storage. Agents handle research and writing; the
service handles records, references, validation, history and access. Publication
requires the owner's confirmation, and research workflows report findings without
silently correcting the knowledge base.

## What you can use it for

- **Personal and project knowledge:** collect notes, ideas, reference material and
  decisions that remain available across agent sessions.
- **Evidence-backed research:** preserve originals, record dated findings, compare
  alternatives and develop durable concepts with traceable sources.
- **Writing and editorial work:** maintain article and post drafts alongside their
  original input, supporting evidence and unresolved questions.
- **Knowledge maintenance:** assign incremental factchecks or broader reviews,
  inspect discrepancies and decide which changes to make.

## Features

- **Structured knowledge, flexible text.** Twelve record types cover raw sources,
  research readouts, entities, concepts, comparisons, researched answers, ideas,
  notes, article drafts, post drafts, metadata pages and architecture decisions.
  Markdown bodies are paired with structured tags, relationships and provenance.
- **Source preservation.** Keep exact original text bytes and PNG, JPEG or PDF
  attachments with server-verified checksums. Source corrections create new
  revisions; processed records reference the evidence they used.
- **Revision history and reliable edits.** Stable IDs survive title changes.
  Atomic change groups, expected-revision checks and idempotent retries prevent
  partial updates and silent overwrites. Archival retains history.
- **Search and navigation.** Russian/English full-text search, exact regex search,
  page and heading reads, a paginated catalog, incoming/outgoing relationships and
  reverse source references make context directly retrievable through tools.
- **Managed taxonomy and diagnostics.** Use tag counts, tag inspection,
  deterministic suggestion context, taxonomy validation and structural/editorial
  diagnostics. Catalog and search update with accepted changes; agents do not
  maintain an index or activity log by hand.
- **MCP access with distinct identities.** A personal agent manages knowledge;
  an optional separate factchecker can submit its own work but cannot edit the
  records it checks. External OAuth and local permission assignments govern access.
- **Owner-controlled publication.** Publish a specific revision and explicitly
  selected attachments through a browser confirmation page. Subsequent edits stay
  private until approved; linked sources and records do not inherit public access.
  Published content is available to anonymous MCP readers when enabled.
- **Incremental factchecking.** Queue the initially unchecked eligible corpus,
  then detect substantive content and evidence changes. External agents receive
  versioned tasks through MCP polling or signed webhooks and return structured
  claims, verdicts and evidence.
- **Separate knowledge reviews.** Start a selected review campaign or enable a
  periodic corpus review. Receive factual findings and proposals concerning stale
  content, duplicates and relationships, without automatic knowledge edits.
- **Recoverable agent workflows.** Reservations, leases, saved progress, bounded
  retries and durable results support interrupted work. Generated evidence reports,
  campaign totals and escalation events remain available independently of optional
  notification delivery.
- **Self-hosted operations.** Docker Compose packages API, worker, PostgreSQL,
  Authelia and Caddy. Persistent data, attachments and credentials are separated
  from application images, with documented backup, restore and upgrade procedures.

## Product boundaries

Each instance serves one knowledge base and one owner, with multiple distinguishable
agent identities. MCP is the primary working interface; the browser UI is limited
to publication approval, not a general-purpose notes editor or public wiki website.

The service does not include an LLM or execute research itself. You supply an
external agent and its model/search capabilities; the protocol is not tied to
Hermes or a particular model provider. Self-hosted storage does not mean that data
stays local when you grant access to a cloud-based agent.

Search is lexical, not vector-based. This is not an Obsidian vault, a multi-user
collaboration platform or an automatic chat-memory integration. Factchecking
records evidence and uncertainty; it does not guarantee that a claim is true.

PostgreSQL stores knowledge and workflow state; Markdown is the text format, not
the database. See [MCP v2](docs/MCP.md) for the interface and
[local acceptance evidence](docs/VERIFICATION.md) for tested behavior and limits.

Publication, factchecking and periodic review are disabled by default. No personal
corpus, external agent, schedule or deployment is initialized automatically.

## Prerequisites

- Docker with Compose 2.24.4 or later.
- Bun 1.3.14 for repository tooling, plus OpenSSL and ripgrep for local tests.
- For deployment: two operator-owned HTTPS hostnames and a protected configuration
  directory outside the repository.

Images are pinned in `compose.yml` and `Dockerfile`: Bun 1.3.14, PostgreSQL 17.11,
Caddy 2.11.4 and Authelia 4.39.24. Fixed stable Authelia passed the resource-binding
probe; the previously considered prerelease is not used.

## Create an instance

Choose `INSTANCE_DIR` outside this repository; its parent must exist. The initializer
refuses to overwrite an existing directory. Replace the example hostnames and email.

```sh
bun run tools/initialize.ts --directory "$INSTANCE_DIR" \
  --wiki-host wiki.example.com --auth-host auth.example.com \
  --tls-email owner@example.com
```

Generated credentials are saved under the protected instance directory, never
printed. The instance starts with neutral taxonomy and an empty knowledge catalog.
Code, service documentation and examples are not imported.

Before deployment, follow [setup](docs/OPERATIONS.md#first-start): configure the
personal-agent redirect URI and register the generated owner's opaque subject with
Authelia. The username `owner` alone never grants wiki permissions.

Then use the generated Compose environment file:

```sh
docker compose --env-file "$INSTANCE_DIR/compose.env" up -d --build
```

This is an operator deployment command, not part of repository verification.
Only Caddy exposes ports; API, worker and the two separately credentialed databases
remain internal. Knowledge and blobs persist across image replacement.

## Use the service

Connect a pre-registered OAuth client to `https://<wiki-host>/mcp`. The personal
agent uses authorization code + S256 PKCE with refresh. The optional factchecker
uses client credentials. Both send `resource=https://<wiki-host>/mcp`. The wiki
introspects every authorized request and independently checks the subject/client
grant, expiry, audience and required scopes.

The eleven familiar read tools remain, but their arguments use IDs/revisions,
not vault paths. Typed atomic changes, source/attachment intake, publication
requests, assignment lifecycle and escalation tools are added. See
[MCP v2](docs/MCP.md) and [content vocabulary](SCHEMA.md).

There is no unauthenticated local administrative transport. Development clients use
the same HTTP authorization boundary as remote clients.

Enable publication with `PUBLICATION_ENABLED=1` in the instance's `wiki.env`.
An agent requests a specific revision; the owner signs in at `/auth/login` and
confirms it at `/publications`. Editing does not change the already public revision.
Sources, related entries and attachments do not become public automatically.

## Independent factcheck agents

Enable `FACTCHECK_ENABLED=1` only when an executor is configured. The agent polls
`wiki_factcheck_next`, claims the assignment, reports progress and submits the
structured result. A configured signed webhook delivers the same task contract;
delivery is not execution. No Hermes CLI, Git or provider-specific batch API is used.

Review is separate: `REVIEW_ENABLED=1` allows explicit campaigns; a positive
`REVIEW_INTERVAL_SECONDS` additionally enables periodic review. It returns
proposals, never automatic knowledge corrections. See [workflow contract](docs/FACTCHECK_CONTRACT.md)
and [operations](docs/OPERATIONS.md).

## Verify locally

```sh
bun run tools/verify.ts
```

Verification installs frozen dependencies in OS temp, starts isolated PostgreSQL
and a full synthetic Compose stack on loopback HTTPS, and removes only its own
resources. It never uses operator configuration or data. Network access is needed
for pinned image/dependency downloads. Do not install `node_modules` in this checkout.

[Contracts and ADRs](docs/README.md) describe the maintained boundaries.
[Operations](docs/OPERATIONS.md) covers backup, restore, upgrades and secret rotation.
The former Markdown-template runtime is not a supported parallel backend. Migration
means creating a new empty service instance; corpus import is a separate explicit task.

A real ChatGPT OAuth reconnect and scheduled execution are separate operator tests.
Local protocol tests do not certify a particular client connection.
