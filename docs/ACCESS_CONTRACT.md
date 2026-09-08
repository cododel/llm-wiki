# Identity and access contract

Status: accepted target; not a statement of current runtime capability.

## Authentication boundary

An external OAuth service owns login, authorization consent, token issuance, and authentication state. The wiki does not retain its embedded authorization-server implementation as a supported remote mode.

The wiki receives a verified identity and permission context for each operation and enforces domain authorization itself. A proxy granting entrance to the endpoint is not sufficient authorization for every tool. Neither shared network location nor unverified identity headers may grant privileges.

Keep owner identity, client/executor identity, permissions, and assignment ownership distinguishable. Credentials and auth state do not belong in knowledge content, webhook task context, or logs.

## Roles

| Identity | Reads | Writes |
|---|---|---|
| Personal agent | All knowledge, including private context and evidence | Content management under the knowledge contract; factcheck execution and management |
| Optional separate factchecker | All knowledge needed for research, including private sources | Its authorized factcheck assignments, progress, failure reports, and submitted results only |
| Anonymous public reader, when enabled | Explicitly published knowledge only | None |

The personal agent may execute factchecks without a separate factchecker deployment. Separate identities must remain distinguishable even when acting for the same owner. The factchecker cannot edit checked pages, expand its permissions, or claim another executor's active assignment.

Full content access does not grant shell execution, secret access, arbitrary filesystem operations, or silent rewriting of immutable source payloads. Authentication and permission checks apply to every operation, not only tool discovery.

## Publication

The anonymous public endpoint is optional and disabled by default. Publication is an explicit authorized content operation; type, folder, lifecycle `published`, and linkage from a public page do not publish another entity.

Public reads must gate bodies, metadata, references, search excerpts, and candidate lists. Private reference targets and attachments do not inherit public access. Operational state and credentials are never public knowledge. The exact `visibility: public` rule remains the Markdown representation of explicit publication.

## Acceptance anchors

Demonstrate personal-agent versus factchecker allow/deny behavior, immutable-source protection, assignment ownership, denied forged identities, no proxy bypass, public non-leakage, and fail-closed behavior when remote authentication is unavailable or incomplete.

Decision provenance: [external OAuth and identities](adr/adr-20260908-external-oauth-identities.md).
Related: [knowledge](KNOWLEDGE_CONTRACT.md), [factchecking](FACTCHECK_CONTRACT.md), [deployment](DEPLOYMENT_CONTRACT.md).

