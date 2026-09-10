# Use resource-bound external Authelia authentication

Status: accepted
Date: 2026-09-10
Decision authority: operator-selected Authelia, followed by explicit version/provider reconsideration and temporary prerelease approval.

## Context and alternatives

Authelia 4.39.22 failed the actual resource-only OAuth probe. Accepting a missing
audience or substituting the non-equivalent audience request parameter would weaken
the agreed MCP authentication contract. A different provider or a fixed Authelia
build was therefore considered. A fixed upstream prerelease passed the probe;
the operator accepted a temporary immutable prerelease pin rather than blocking
implementation on a release. Before adoption, stable 4.39.24 became available and
passed the same probe, making the prerelease unnecessary.

## Decision

Retain external-only Authelia with pre-registered interactive, machine and technical
clients. Use the verified stable 4.39.24 image pinned by digest. Keep opaque tokens,
per-request introspection, resource/audience validation and local subject/client
permission assignments. No provider-owned identity is inferred from an HTTP header.

## Consequences and revisit conditions

The wiki avoids maintaining a token issuer but depends on external verification
availability and fails closed when it is unavailable. Provider upgrades require
the real auth gate again. A successful disposable probe is not evidence of a real
ChatGPT reconnect or scheduled execution; those remain operator acceptance steps.

Current contract: [access](../ACCESS_CONTRACT.md).
Evidence: [compatibility report](../auth-compatibility-20260908.md).
Related: [external identities](adr-20260908-external-oauth-identities.md).
