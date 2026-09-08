# Enforce structural workflow guarantees in the service

Status: accepted
Date: 2026-09-08
Decision authority: explicit operator agreement in the repository design conversation.

## Context

Operational skills repeatedly instruct agents to preserve raw, synchronize provenance, repair generated links, count results, and validate the exact multi-file candidate. Prompt compliance alone has produced fragile workflows.

## Alternatives and rationale

Keep these obligations in agent instructions or enforce objectively checkable invariants in the service while leaving semantic judgment to agents. The operator approved the latter after reviewing the accumulated skill rules and their contradictions.

## Decision

Make integrity, revision conflicts, reference validation, provenance maintenance, readout construction, and execution lifecycle service responsibilities. Keep truth assessment, source relevance, editorial decisions, and semantic graph repair with agents/operators.

## Consequences and invariants

Service implementation grows, but clients no longer reconstruct the same mechanical workflow. Passing structural validation cannot be advertised as proof of truth or human approval. Historical skill exceptions must not become universal rules.

## Reversibility and revisit conditions

Revisit individual guards when they force fabricated content or conflate semantic judgment with structural validation.

Current contract: [KNOWLEDGE_CONTRACT.md](../KNOWLEDGE_CONTRACT.md).
Related decisions: [decision index](README.md).

