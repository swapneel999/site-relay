# website-builder-mark2

The schema and agent-definition layer for a multi-tenant, multi-agent website-builder pipeline.

Each client moves through a fixed pipeline of stages:

```
kickoff → scraping → design_homepage → mockup_review → mockup_revision →
design_locked → design_remaining_pages → backend_build → qa → qa_revision →
integration_signoff → complete
```

(plus a `blocked_needs_human` escape hatch), handled by five specialized Claude Code subagents
that read/write a shared set of JSON files under each client's `.pipeline/` directory to hand off
state to one another.

There is no live orchestrator in this repo yet — what exists is the **contract**: JSON Schemas for
every pipeline file (`schemas/`), subagent definitions (`.claude/agents/`), hooks that mechanically
enforce each agent's write boundaries (`scripts/hooks/`), and the CLI wrapper scripts those agents
(and one human-run onboarding step) call via `Bash` (`scripts/`).

## Start here

- [`CLAUDE.md`](./CLAUDE.md) — operating instructions and architecture reference for Claude Code.
- [`docs/PROJECT_SUMMARY.md`](./docs/PROJECT_SUMMARY.md) — narrative overview of the *why*.
- [`docs/spec.md`](./docs/spec.md) — authoritative field-by-field schema reference.

## Commands

```bash
bun test                                          # full suite
bun test tests/schemas/kickoff.test.ts            # a single schema test
bun test tests/agents/<name>-output.dry-run.test.ts  # a single agent's dry-run output validation
bun test tests/hooks/validate-<name>-agent.test.ts   # a single hook's unit tests
```

There's no build/lint step — `bun` runs `.ts` files directly, and `tsconfig.json` (`noEmit: true`) is
editor-only. The one exception is `scripts/a11y-audit.ts`, which runs under
`node --experimental-strip-types` (see that file's own header for why).
