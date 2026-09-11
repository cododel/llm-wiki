# Service operations

All commands here are operator actions. Repository verification uses generated disposable
instances instead. Keep the instance directory and backups outside the repository, mode 0700,
on encrypted storage. Never print or commit generated secrets.

## First start

Run the initializer described in the [README](../README.md). Set `INSTANCE_DIR` to that exact
external directory. Review `authelia/configuration.yml`, replacing the personal-agent placeholder
redirect URI with the exact registered client callback. Supply its client ID and secret through
the client's protected credential configuration. Do not add wildcard callbacks.

The generated personal and browser clients use a single-factor owner login; enable Authelia MFA
according to your operating policy before exposing sensitive material. The separate browser client
is not a shortcut for agent publication approval. File notification output is a bootstrap choice,
not a configured email service. Configure a notifier externally if using account recovery/MFA.

Start storage and Authelia before the first owner login:

```sh
docker compose --env-file "$INSTANCE_DIR/compose.env" up -d postgres authelia
docker compose --env-file "$INSTANCE_DIR/compose.env" exec -T authelia \
  authelia storage user identifiers add owner \
  --identifier "$(<"$INSTANCE_DIR/secrets/owner-subject")" \
  --config /config/configuration.yml
docker compose --env-file "$INSTANCE_DIR/compose.env" up -d --build
```

The subject UUID is an identity, not a secret. It must match the browser/personal grants in
`secrets/auth-grants.json`. If an owner already logged in and obtained another opaque identifier,
inspect Authelia's identifier mapping and deliberately reconcile the local grants; do not grant
access by username. A technical introspection client has no local knowledge grant.

The initializer's `--factchecker` flag adds the separate machine grant. Without it, the
pre-registered machine client cannot access knowledge even if it obtains a token. The personal
agent can execute both workflows without this optional grant.

## Configuration and activation

Edit external `wiki.env`, then recreate API/worker. Changes to grants or mounted credentials
also require recreation; tokens are still introspected on every request.

| Variable | Default / meaning |
|---|---|
| `PUBLICATION_ENABLED` | `0`; `1` permits explicit owner-approved publication |
| `FACTCHECK_ENABLED` | `0`; `1` enables incremental detection and polling |
| `REVIEW_ENABLED` | `0`; `1` enables explicit review campaigns |
| `REVIEW_INTERVAL_SECONDS` | `0`; positive interval additionally enables periodic review |
| `FACTCHECK_CONCURRENCY`, `REVIEW_CONCURRENCY` | `1` each; range 1–20 |
| `WORK_LEASE_SECONDS` | `300`; range 30–3600 |
| `WORK_MAX_ATTEMPTS` | `3`; range 1–10 |
| `FACTCHECK_WEBHOOK_URL`, `REVIEW_WEBHOOK_URL` | Optional operator-controlled HTTPS destinations |
| `NOTIFICATION_WEBHOOK_URL` | Optional separate escalation destination |
| `<CHANNEL>_WEBHOOK_SECRET_FILE` | Required file path when that webhook is configured |

Add webhook secrets with an **external** Compose override, mounting each only into API/worker
under `/run/secrets/`. Set the corresponding `_FILE` path in `wiki.env`; do not put the key in an
environment value or task. For example, an external override can declare
`secrets.factcheck_webhook.file` and add `factcheck_webhook` to both services' secret lists.
Pass both `-f compose.yml -f "$INSTANCE_DIR/webhooks.yml"` to every Compose command thereafter.
Secrets mounted to the non-root Bun process must be readable inside that container while host
parent directories remain owner-only. Disable a channel by removing its URL and recreating.

Polling needs no webhook, wrapper, external cron or Hermes profile. A scheduler invokes the
same MCP next/claim/progress/complete protocol. Webhook receivers verify
`X-Wiki-Signature = sha256=HMAC_SHA256(secret, timestamp + "." + raw_body)`, reject old timestamps
(for example, outside five minutes), deduplicate `X-Wiki-Event`, then claim over MCP.
Do not treat a 2xx delivery response as a research result.

## Queue recovery and observability

Worker restart recovers expired job and delivery leases. Saved progress is returned to the next
owner of a claim. Retry is delayed one minute and bounded; exhausted work remains failed with an
event. Skipped/blocked fingerprints are not immediately requeued. Start explicit review to revisit
unchanged work after resolving its blocker. There is no automatic content correction.

Use `wiki_events_list`, `wiki_event_acknowledge`, `wiki_event_resolve`, and
`wiki_review_summary`. Acknowledgement is not resolution. Notification delivery failure does not
remove the event. Inspect service logs and `/health` for process availability; that endpoint does
not certify provider availability or research freshness. No tokens or source bodies are logged.

## Backup and restore

Choose a new protected `BACKUP_DIR`. Stop writers before copying a coherent snapshot; include
Authelia to keep identity/session state consistent. Never use `down --volumes` on an operator instance.

```sh
docker compose --env-file "$INSTANCE_DIR/compose.env" stop api worker authelia
docker compose --env-file "$INSTANCE_DIR/compose.env" exec -T postgres pg_dump -U postgres -Fc wiki > "$BACKUP_DIR/wiki.dump"
docker compose --env-file "$INSTANCE_DIR/compose.env" exec -T postgres pg_dump -U postgres -Fc authelia > "$BACKUP_DIR/authelia.dump"
docker compose --env-file "$INSTANCE_DIR/compose.env" run --rm --no-deps --entrypoint tar api \
  -cf - -C /var/lib/wiki/blobs . > "$BACKUP_DIR/blobs.tar"
tar -cf "$BACKUP_DIR/config.tar" -C "$INSTANCE_DIR" .
docker compose --env-file "$INSTANCE_DIR/compose.env" start authelia api worker
```

Protect/encrypt these files: configuration contains login credentials, database passwords and
encryption/signing keys. Record image digests and application revision with the backup.

Restore first into a **new isolated Compose project and new volumes**, with external exposure
disabled. Restore the protected configuration under a different instance path, adjust `compose.env`,
and start PostgreSQL only. Restore into newly empty wiki/Authelia databases using
`pg_restore --exit-on-error -U postgres -d <database>` through `compose exec -T postgres`.
Restore blob archive via a one-off API container with `--entrypoint tar -xf - -C /var/lib/wiki/blobs`.
Do not restore over populated databases or blobs. Verify original hashes, counts, revision
pointers, pending jobs/outbox and owner login before considering a cutover. Preserve the old
instance until recovery is accepted. The unified test exercises a synthetic restore, not your backup.

## Upgrades and secret rotation

Back up first. Review immutable SQL migrations, pinned images and release notes. Test the new
image against a restored disposable backup before replacing API/worker. Both run locked,
transactional migrations and seed once; image replacement does not overwrite content.
For v2-to-v3, stop **both API and worker** throughout the maintenance window; do not run mixed
versions against one database. Migration 005 adds the fixed model and records pending historical
projections. Startup processes batches of 1,000 revisions transactionally before opening API or
worker loops. A crash rolls back only its active batch; restart resumes pending rows. Existing
revisions, bytes, published pointers, requests, jobs and checkpoint fingerprints are not rewritten.
Check `SELECT count(*) FROM legacy_backfill_pending` through the operator's database console:
zero means projection is complete, not that all release acceptance has passed. Do not manually
remove pending rows. Repeat startup is safe. New installations seed no taxonomy or content;
old taxonomy becomes topics and old editorial types become format labels. Legacy maturity stays unknown.

Clients should discover v3 using `wiki_describe`. Existing v2 clients remain usable for legacy
content but must handle `unsupported_contract` when native knowledge enters their read scope.
Do not downgrade by dropping new columns/tables or rewriting sealed revisions. If rollback is
needed, restore the complete pre-upgrade backup with the matching old image.

Edit locks are not ownership permissions. To delegate lock management, deliberately add
`"capabilities": ["manage_locks"]` to the exact personal-agent entry in the external grant file,
then recreate API/worker. No skill or requested OAuth scope grants this capability.
Rollback means restoring a coherent prior database/blob/config backup with its matching image,
not running an older binary blindly on a newer schema.

For client-secret rotation, register the replacement hash in Authelia, update the corresponding
external secret/client configuration, and recreate affected containers. Revoke old tokens and
verify protected MCP denial. Database password rotation also requires changing the PostgreSQL
role password: replacing a Docker secret alone does not alter an initialized role.

Changing the wiki session encryption key invalidates existing encrypted browser sessions/flows;
expire those rows in a planned maintenance window and sign in again. Do not casually rotate
Authelia's storage encryption key: use the selected version's documented migration procedure.
Rotate signing keys with a planned overlap and test discovery/ID-token verification.

## Transition from the old template

Create a new empty service instance. There is no hidden file-vault compatibility backend, Git
write workflow, automatic corpus migration or template synchronization. Retain old data separately
until an explicitly scoped importer has been designed and verified. Editorial Markdown templates
remain scaffolds for API document bodies, not importable records by themselves.

Real ChatGPT reconnect and scheduled execution require separate operator-controlled tests.
