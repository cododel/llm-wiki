# LLM Wiki service

A single-owner knowledge service for humans and agents. PostgreSQL stores stable
records, immutable revisions, original-source provenance, jobs and audit. Markdown
is the text format, not the database. Agents work through MCP v2; the owner confirms
publication of individual revisions in a small browser page.

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
