# Identity, access and publication contract

Status: normative service access contract for v2/v3.

## Authentication

External Authelia 4.39.24 owns authentication, consent, opaque token issuance and revocation.
The version decision and compatibility evidence are recorded in
[ADR](adr/adr-20260910-resource-bound-authelia.md) and
[auth report](auth-compatibility-20260908.md). Embedded OAuth is not supported.

Every authorized HTTP request requires live introspection using the separate wiki technical
client. There is no positive cross-request cache. Inactive, expired, foreign-audience,
foreign-issuer or incomplete identities fail closed; provider unavailability denies protected
access. Wiki then checks scopes and an explicit local subject/client grant. Requested scopes,
client names, forwarded headers, network location and usernames cannot create a role.
Credentials, mappings and auth state are external to knowledge and task context.

## Roles

| Identity | Read | Write |
|---|---|---|
| Personal agent | All knowledge and evidence | Content, taxonomy, publication requests, assignments and event handling |
| Optional factchecker | All knowledge and evidence | Claim, progress, results and failure for its own assignments |
| Browser owner | Approval context and selected evidence | Confirm exact publication requests through browser session |
| Anonymous, when publication enabled | Published revisions and selected attachments | None |

The personal agent can execute work without a separate factchecker. Claims bind to the verified
actor and a fresh lease token. Full knowledge access never includes shell, arbitrary filesystem
access, authentication configuration or the right to approve publication via MCP.

Personal agents may create/edit unlocked skills, never execute them inside the service.
Changing an edit lock additionally requires `capabilities: ["manage_locks"]` on that exact local
personal subject/client grant. The initializer grants no such capability. A requested scope,
skill instruction or an ordinary content edit cannot unlock or archive a locked object.
Locks do not prevent reading, unpublishing or owner approval; those are separate controls.

## Revision publication

Publication is disabled by default. The personal agent requests a specific current revision and
explicit subset of its attachments. Neither type, directory, status, links nor a metadata marker
publishes knowledge. The browser owner sees exact requested content, the prior public version,
check results and discrepancies before deciding. Factcheck informs but does not veto approval.

A separate OIDC client establishes a browser session with PKCE, state, nonce and verified ID
token. Approval checks the live owner identity, session, same-origin CSRF token, request expiry,
pending state and unchanged current revision. Agent bearer tokens cannot approve. An edit after
request formation makes that request stale. Render untrusted Markdown as escaped source text,
not active HTML. No approval MCP tool exists.

Editing a published record leaves its previously approved revision public. Unpublish/archive
hide it while preserving history. Sources and related records require separate approval.
Attachments are independently selected; knowing a private hash does not grant download access.

## Non-leakage

Access selection precedes search, rank, counts, resolution, graph links and diagnostics.
Public responses cannot expose private new revisions through metadata, history, source references,
attachments or errors. Auth failures are sanitized. Explicitly approved body text itself may
contain sensitive prose or links; owner review remains necessary.
Public topic/format names and aliases are pinned to the published revision. Mutable registry
renames, collection membership and private lock state are not public metadata. Skill dependencies,
source provenance and derived-revision links are filtered independently; they never publish targets.

Verification anchors: role/client/subject matrix, audience/revocation/provider failure,
old-public/new-private matrix, stale approvals, CSRF, escaped content and private attachments.

Decisions: [identities](adr/adr-20260908-external-oauth-identities.md),
[owner revision publication](adr/adr-20260910-owner-revision-publication.md).
