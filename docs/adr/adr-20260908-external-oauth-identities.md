# Delegate OAuth to an external service

Status: accepted
Date: 2026-09-08
Decision authority: explicit operator agreement in the repository design conversation.

## Context

Embedded single-owner OAuth and process-wide readonly scope cannot express the new distinction between a personal agent and an optional dedicated factchecker.

## Alternatives and rationale

Keep and extend embedded OAuth, support both embedded and external modes, or delegate remote OAuth to an external service. The operator selected external-only ownership to avoid maintaining a login/token system in the wiki. Separate executor identities were selected over using one owner credential for every workflow.

## Decision

Use external OAuth and distinct agent identities with domain permissions enforced by the wiki. The personal agent manages knowledge; a separate factchecker, when present, has restricted result-writing authority.

## Consequences and invariants

The service must receive verified identity context rather than only a yes/no endpoint gate. Deployment gains an external component. No specific proxy product or unattended grant has been selected.

## Reversibility and revisit conditions

Revisit the provider choice when compatibility and identity propagation are verified; do not restore embedded OAuth implicitly.

Current contract: [ACCESS_CONTRACT.md](../ACCESS_CONTRACT.md).
Related decisions: [decision index](README.md).

