# Authelia implementation gate: resource binding

Status: stable 4.39.22 fails; fixed stable 4.39.24 passes the focused auth gate.
Not complete service or ChatGPT acceptance.
Date: 2026-09-08
Baseline: `fb4e9515d689bce9984b85bff79c2a81a841f2d3`

## Required behavior

The operator-approved service implementation plan selects Authelia 4.39.22,
opaque access tokens, per-request introspection, and authorization code + PKCE
with the MCP `resource` parameter. The wiki must verify token audience before
allowing access. The plan explicitly requires stopping the authentication stage
on incompatibility instead of silently replacing the provider or weakening checks.

## Tested environment

- Official `authelia/authelia:4.39.22` image, reporting `authelia version v4.39.22`.
- Pulled digest: `sha256:936134132eaf01bfa2faf85055afbc1e0cc1cc5ca4547e9c06408fd0dd784646`.
- Docker 29.4.0, Bun 1.3.14, local ARM64 host.
- Disposable Compose project with one Authelia container, loopback-only published
  port, synthetic credentials, isolated authentication storage, and TLS validated
  against an explicitly trusted test certificate.
- Separate registered client IDs for a personal agent, owner browser, factchecker,
  and technical introspection client. Each client permits the exact test resource
  `https://wiki.wiki.test/mcp` in its `audience` configuration.
- Default audience configuration and an additional run with
  `requested_audience_mode: implicit` were both tested.

No real wiki, owner account, ChatGPT connection, or deployment was accessed.

## Results

### Client-credentials binding matrix

All requests below use the same registered factchecker client and introspect the
issued opaque token through the separate technical client.

| Token request | Result | Introspection audience |
| --- | --- | --- |
| `resource=https://wiki.wiki.test/mcp` | HTTP 200, active token | `aud` absent |
| `audience=https://wiki.wiki.test/mcp` | HTTP 200, active token | Exact requested audience present |
| Both permitted `resource` and `audience` | HTTP 200, active token | Exact requested audience present |
| Unpermitted `resource` | HTTP 400, `invalid_target` | No token |
| Unpermitted `audience` | HTTP 400, `invalid_target` | No token |
| Unpermitted scope | Rejected | No token |

For the resource-only token, the returned introspection fields were:

```text
active, client_id, exp, iat, iss, scope, sub
```

Neither `aud`, `resource`, nor `resources` exposed the granted resource binding.
The implicit-audience configuration did not change this result.

### Interactive flow

With the same permitted `resource` supplied at both authorization and token
endpoints, login and explicit consent complete, but exchanging the authorization
code with the correct S256 verifier returns:

```json
{"error":"invalid_target"}
```

This was reproduced with default and implicit audience configuration.

A control run substituting `audience` for `resource` passed:

- Discovery, S256 and required grant advertisement.
- Synthetic owner login and explicit consent.
- Authorization code + PKCE for both personal-agent and owner-browser clients.
- Distinguishable client IDs and user versus service subjects in introspection.
- Opaque machine access token with verifiable audience and expiry.
- Cross-client introspection.
- Refresh rotation and rejection of the old access token.
- Explicit revocation and inactive-token introspection.

The control isolates the resource-binding failure from the fixture's login,
consent, TLS, and PKCE handling. It does not pass the MCP authentication gate.

## Interpretation and boundary

The selected release does not satisfy the approved resource-only OAuth flow in
this reproducible configuration. Subsequent investigation located the upstream
defect and an unreleased fix (see below). Successful handling of the non-equivalent `audience`
parameter is not evidence that the MCP `resource` flow works.

Do not infer audience from client identity, accept an absent audience, remove
`resource` from requests, or substitute JWT tokens to make the gate pass.
PostgreSQL/service implementation has not started behind an unpassed auth gate.

The operator approved reconsidering the version/provider while preserving the
accepted identity and publication boundaries. That permits compatibility probes;
it does not silently establish a prerelease as the supported distribution baseline.

## Follow-up: upstream fix and successful prerelease probe

Upstream [PR #12973](https://github.com/authelia/authelia/pull/12973), merged as
`01f1d1ec1403ff08e7e833b1084ccfc197b21aa9`, fixes resource indicators not being
recorded or granted after the OAuth provider dependency split audience and resource
concepts. This matches both observed failures. It includes persistence and consent
changes, so a wiki-side parameter substitution is not an equivalent repair.

At the follow-up check, the latest stable release remained 4.39.22. The PR-specific
Docker tag advertised by upstream was no longer available. The official master
image was therefore resolved and tested by immutable digest:

- Image: `authelia/authelia@sha256:4a8bd58415d85ceefc4c97ef1a9004485891fdb447cd11eca80d77e9194708e9`.
- Image revision: `e948a3ff0e3df748c02a6693dbf9f848fb53d61f`.
- Binary: `authelia version untagged-v4.39.22 (master, e948a3f)`.
- Image version label: `4.39.22-pre+master.e948a3ff0e3df748c02a6693dbf9f848fb53d61f`.

The same disposable fixture, with fresh synthetic credentials and default audience
configuration, passed the strict resource-only probe without substituting
`audience` or skipping its assertion:

- Discovery and S256/grant advertisement.
- Opaque client-credentials token and cross-client introspection with exact `aud`.
- Rejection of foreign resources and unauthorized scope expansion.
- Login, consent and authorization-code + PKCE for both interactive clients.
- Distinguishable personal-agent, owner-browser and machine identities.
- Resource binding retained through interactive code exchange.
- Refresh rotation and old access-token rejection; explicit revocation.

This proves the focused provider protocol prerequisite on that exact prerelease,
not the full service access matrix, browser publication flow, PostgreSQL deployment,
or a real ChatGPT connection. No service code or deployment configuration was
changed to adopt this image. The remaining decision at that time was whether the distribution
may temporarily pin the prerelease or must wait for a stable release containing
the upstream fix.

## Stable release follow-up: 2026-09-10

The operator approved temporary use of the pinned prerelease. Before adopting it,
a fresh release check found that stable 4.39.23 included PR #12973 and additional
resource-matching and client-credentials fixes. Stable 4.39.24 was then tested with
the same strict resource-only probe and passed all assertions listed above.

The service distribution uses
`authelia/authelia:4.39.24@sha256:8f428b06bb07bb978c10477527634f19ef3b049c9c87321fda14e24d8fc4c535`.
No prerelease is needed. This follows the operator's permission to reconsider the
provider version without weakening resource validation or identity separation.

Sources: [4.39.23 release](https://github.com/authelia/authelia/releases/tag/v4.39.23),
[4.39.24 release](https://github.com/authelia/authelia/releases/tag/v4.39.24).

## Evidence sources

- [Versioned Authelia integration documentation](https://github.com/authelia/authelia/blob/v4.39.22/docs/content/integration/openid-connect/introduction.md)
- [Versioned registered-client configuration](https://github.com/authelia/authelia/blob/v4.39.22/docs/content/configuration/identity-providers/openid-connect/clients.md)
- [OpenAI MCP authentication requirements](https://developers.openai.com/plugins/build/auth)

The documentation justified testing this release. The executed results above,
not its advertised feature list, determine this implementation-gate verdict.
