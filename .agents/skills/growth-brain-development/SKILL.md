---
name: growth-brain-development
description: Resume and review Growth Brain memory, capture, MCP, encryption and developer handoff work with the repository's pinned public skills.
---

Read root AGENTS.md and docs/development-handoff.md first. This is a development skill; the separately installed integrations/codex/growth-brain skill is the user's product integration.

Use the source map in docs/public-skills.md to read only applicable pinned skills and their needed references. For each review loop: state the user-facing invariant, inspect code and callers, reproduce a concrete fault or assess evidence, make an authorized focused fix, run meaningful verification, record limits, commit/push/verify. Prefer existing test infrastructure and synthetic data.

Routes:
- Product acceptance and missed cases: product-on-purpose acceptance criteria / edge cases.
- Local vault/protocol boundaries: OpenAI security best practices / threat model; distinguish known same-user OS trust from network isolation.
- Changes and regressions: Trail of Bits differential review / property-based testing. Generated tests need independent oracles and repeatable seeds, not copies of implementation.
- Tool contracts and rendered review UI: Anthropic MCP builder / webapp testing. Preserve current SDK unless a separately justified migration is needed. Test actual transport and Chromium fixtures; label live client gaps.
- Actual user benefit: product-on-purpose experiment design. Development corpus results are not user experiments or general accuracy guarantees.

Do not run vendored scripts automatically, install runtime dependencies from their examples, upload private memories, change production services or weaken consent for a review. No embedding/cloud model dependency is implied. Respect already given user authorization; do not re-ask settled deployment/security questions.
