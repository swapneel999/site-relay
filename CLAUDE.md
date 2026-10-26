# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is the **schema and agent-definition layer** for a multi-tenant, multi-agent website-builder pipeline. Each client moves through a fixed pipeline of stages (`kickoff → scraping → design_homepage → mockup_review → mockup_revision → design_locked → design_remaining_pages → backend_build → qa → qa_revision → integration_signoff → complete`, plus a `blocked_needs_human` escape hatch), and a sequence of five specialized subagents read/write a shared set of JSON files under a per-client `.pipeline/` directory to hand off state to each other.

There is no live client and no orchestrator implementation in this repo yet — what exists is the **contract**: JSON Schemas for every pipeline file, subagent definitions (`.claude/agents/*.md`) that consume that contract, hooks that mechanically enforce each agent's write boundaries, and a small set of CLI wrapper scripts those agents (and one human-run onboarding step) call via `Bash`. Read `docs/spec.md` before changing any schema or agent — it is the authoritative field-by-field reference; if `docs/spec.md` and a `.schema.json` disagree on *shape*, the schema wins (it's machine-checked), but if either disagrees with `docs/superpowers/specs/2026-07-03-client-pipeline-state-schema-design.md` on *intent*, the design doc wins and the drifted file needs fixing.

## Commands

- Run the full test suite: `bun test`
- Run a single schema test: `bun test tests/schemas/kickoff.test.ts`
- Run a single agent's dry-run schema validation (also runnable standalone, self-skips until real agent output exists): `bun test tests/agents/<name>-output.dry-run.test.ts` — one per agent (`scraper-output`, `design-lock`, `backend-output`, `qa-output`, `signoff-output`).
- Run a single hook's unit tests: `bun test tests/hooks/validate-<name>-agent.test.ts` — one per agent (`scraper`, `design`, `backend`, `qa`, `integration-lead`).
- There is no build/lint script — `tsconfig.json` is `noEmit: true`, used only for editor/type-check purposes (`bun` runs `.ts` files directly). **One deliberate exception:** `scripts/a11y-audit.ts` runs under `node --experimental-strip-types`, not `bun` — a live-verified Bun/Playwright incompatibility on this machine, documented in that script's own header. Don't "fix" its invocation back to `bun` without re-verifying first.

## Architecture

### The shared envelope

Every file in `.pipeline/` wraps its payload identically: `{ schema_version, client_id, last_updated_at, last_updated_by, data: {...} }`. Schemas live in `schemas/*.schema.json` (draft-07), share common `$defs` (e.g. `SourcedField<T>`, `hexColor`, `category`, `severity`) via `schemas/common.schema.json`, and are compiled/validated with `ajv` + `ajv-formats` in `tests/schemas/helpers.ts`'s `compileSchema()`. Every schema has a matching valid/invalid fixture pair under `tests/schemas/fixtures/<name>/`, and `tests/schemas/full-pipeline.test.ts` checks that every valid fixture uses the same fake `client_id` (`acme-co`) across files, so a single fictitious client's full pipeline state stays internally consistent as a cross-file regression check.

### The seven pipeline files and their write ownership

This is the part that matters most when touching an agent or a schema — each file has exactly one owner (or a narrow, explicit split), enforced partly by hooks and partly by instruction. Full detail is in `docs/spec.md`; summary:

| File | Owner | Notes |
|---|---|---|
| `kickoff.json` | human/intake, once | read-only for every agent forever |
| `scraper-output.json` | scraper agent, once | read-only for design/backend/QA after |
| `design-lock.json` | design agent | written once at homepage approval, then append-only (`component_catalog`, `generated_assets`) during `design_remaining_pages` |
| `mockup-approval.json` | split: intake creates rounds/decisions; design/backend only update `status`/`agent_note` on items they own by `category` | rounds are append-only — never shrink, never lose a round number |
| `qa-report.json` | QA agent exclusively, except design/backend may set `status` to `fixed_claimed`/`disputed` on their own assigned findings | only QA can set `verified_fixed`, `wont_fix`, or `superseded` — no agent can dismiss or confirm-fix its own finding; a terminal finding is frozen in **every** field, not just `status` |
| `signoff.json` | split: integration lead writes `checklist`/`unresolved_majors`/`round_outcome`/deployment fields; only human/client-approval intake writes `client_final_approval` | terminal file, not read by any other pipeline file. Every review round except the current one is frozen entirely once a later round exists — there's no reconciliation pattern here the way QA has |
| `pipeline-status.json` | orchestrator only | every agent reads `current_stage` first on invocation — it's authoritative, agents must not infer stage from context |

Concurrency model is strictly sequential (one agent active per client at a time) — this is a deliberate simplicity tradeoff, not an oversight, and it does **not** relax the write-ownership rules above (they exist for audit integrity, not to prevent races).

### The five subagents (`.claude/agents/*.md`)

Each subagent's frontmatter declares its own scoped `tools`, and a `hooks.PreToolUse` entry pointing at a matching script in `scripts/hooks/`. These hooks are **real enforcement**, not documentation — they run only while that specific subagent is active, read the `PreToolUse` JSON payload from stdin, and exit 2 (block, with a stderr reason surfaced to the agent) or exit 0 (allow). Two hook models are used, on purpose:

- **Deny-list** (design-agent, backend-agent): broad `Write`/`Edit`/`Bash` access is unavoidable — building the actual site *is* the job — so the hook blocks a short, fixed list of files instead of allow-listing everything else.
- **Allow-list** (scraper-agent, qa-agent, integration-lead-agent): the agent's legitimate write/bash surface is narrow enough to enumerate exhaustively, so anything not explicitly matched is rejected by default — a stronger guarantee than a deny-list can give.

Agent-by-agent:

- **`scraper-agent`** (hook `validate-scraper-agent.ts`): allow-list. Writes exactly one real file, `.pipeline/scraper-output.json` (plus an ephemeral git-ignored `.pipeline/scraper-cache/places-reviews-preview.json`), and `Bash` is restricted to `scripts/places-lookup.ts` invocations and its own dry-run test — anything else, including shell metacharacters (`` ` ``, `$`, newline) that could smuggle command substitution through an otherwise-matching command string, is rejected. Runs once per client, before any design work.
- **`design-agent`** (hook `validate-design-agent.ts`): deny-list. Blocks writes to the four files it must never touch (`kickoff.json`, `scraper-output.json`, `signoff.json`, `pipeline-status.json`), including disguised `..`-traversal and case-variant paths, and separately enforces round-count-only-grows on `mockup-approval.json`/`qa-report.json` (not full field-level diffing — a deliberate scope decision, see the hook's own comments). Builds the actual Next.js site; owns `design-lock.json`. Uses `scripts/server-lifecycle.ts` for its own dev-server/screenshot capture and a scoped Playwright MCP server.
- **`backend-agent`** (hook `validate-backend-agent.ts`, adapted from design-agent's): deny-list, same four files **plus `design-lock.json`** (backend reads it, never writes it — the fifth protected file, specific to this agent). Wires server-side logic/third-party integrations into the site design-agent already built; never creates new UI. Credentials default to client-owned throughout (contact-form email, payments, scheduling, CMS, etc.) — the one exception is the Places reviews live-fetch, which reuses the scraper's agency-owned `GOOGLE_PLACES_API_KEY` with a required short-TTL cache and a documented rotation runbook (see that agent's own file) referencing `clients.json` as the discovery mechanism.
- **`qa-agent`** (hook `validate-qa-agent.ts`): allow-list, narrower than scraper's. Writes only `.pipeline/qa-report.json`; `Bash` is restricted to `server-lifecycle.ts` (production-build mode, never dev), its own `a11y-audit.ts` invocation (localhost URLs only), and its dry-run test. The write-pattern boundary is its own thing, not reused from design/backend's round-immutability check: rounds/findings are append-only *and* any finding already `verified_fixed`/`wont_fix`/`superseded` is frozen in full, since QA is the one agent structurally incapable of being wrong in its own favor. Runs a real adversarial functional + accessibility pass via Playwright MCP against a local production build — never a read-through.
- **`integration-lead-agent`** (hook `validate-integration-lead-agent.ts`): allow-list. Writes only `.pipeline/signoff.json` (never `clients.json` — see below); `Bash` covers a clean-tree check, `github-repo.ts push`, post-push git verification, and `vercel-deploy.ts` (`env-list`/`check-preview`/`domain-check`/`promote`, never `create-project`). The last agent before `complete`, and the first whose write is a real external side effect: it pushes the final QA-passed code to GitHub (the one push in the whole pipeline — see "GitHub/Vercel provisioning" below for why it's here and not incremental) and, once the client's final approval is separately recorded, promotes to production. Never creates repos/projects, never touches site code.

When adding a new subagent, follow this same pattern: scope `tools` tightly, back any stated boundary with a real `PreToolUse` hook rather than prose alone, and add a corresponding `tests/agents/<name>-output.dry-run.test.ts` (reusing `tests/agents/helpers.ts`'s `pipelineFileExists`/`loadPipelineFile`/`compileSchema`) that self-skips when no live output exists yet and hard-fails with ajv's exact error list when it does.

### GitHub/Vercel provisioning — a human step, not an agent

**`scripts/onboard-client.ts` is a small, human-triggered CLI script — not an agent, no hook, no Claude Code frontmatter.** It runs once per client, manually, at the same moment `kickoff.json` is authored (before design-agent ever runs, since design-agent needs a live `--cwd` site repo starting at `design_homepage`). It creates the client's Vercel project (`vercel-deploy.ts create-project`), verifies the GitHub App installation the client set up can see their repo (`github-repo.ts verify-access`), pushes the initial scaffold, and registers the client in `clients.json`.

**Why the repo/project aren't created later, by an agent:** design-agent's screenshot capture and QA's audit both test against a local dev/build server — neither needs the repo to exist on GitHub to do its own job. Only the client-facing preview/production deployment and integration-lead's final checklist need that, so provisioning happens once, up front, by a human running one script, not by any agent mid-pipeline.

**Ownership model:** client-owned throughout, not agency-owned — same reasoning as backend-agent's credentials default, one layer up. The client's own GitHub repo (personal account or org, either works) with the agency's GitHub App installed scoped to just that one repo (independently revocable by the client, unlike a standing collaborator invite); the client's own Vercel project with an agency-provided, project-scoped token. **GitHub Apps cannot create repositories in a personal account via an installation token at all** (a hard API restriction, confirmed via research, not assumed from docs) — which is why the client creates the empty repo first and the App only ever verifies access + pushes, never creates.

**`clients.json`** (repo root, not under `.pipeline/`, no ajv schema — deliberately out of schema-ceremony scope) is the agency-level registry `onboard-client.ts` writes to: `{client_id, name, repo_url, vercel_project_id, github_installation_id, added_at, added_by}`. It exists specifically so a shared-secret rotation (`GOOGLE_PLACES_API_KEY`) can enumerate every deployment, including clients still mid-build — registering only at final signoff would leave every in-flight client invisible to that runbook for the entire build duration.

**`scripts/github-repo.ts`/`scripts/vercel-deploy.ts`** are unverified against real accounts as of 2026-07-20 (no GitHub App registered, no Vercel token available in this environment) — shipped with a prominent unverified marking in their own headers rather than silently claimed done, per this project's live-testing standard. Live-test both against a real sandbox before the first real client.

### External API wrapper scripts (`scripts/*.ts`)

CLI wrappers, not libraries — agents call them via `Bash` rather than importing them, specifically so raw secrets never pass through agent context. Each reads its own key(s) once from its own process environment and never echoes/logs them.

| Script | Secret(s) | Called by |
|---|---|---|
| `places-lookup.ts` | `GOOGLE_PLACES_API_KEY` | scraper-agent |
| `generate-image.ts` | `GEMINI_API_KEY` | design-agent |
| `github-repo.ts` | `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` | `onboard-client.ts` (`verify-access`, `push`), integration-lead-agent (`push` only) |
| `vercel-deploy.ts` | `VERCEL_TOKEN` | `onboard-client.ts` (`create-project`), integration-lead-agent (`env-list`/`check-preview`/`domain-check`/`promote`) |

`github-repo.ts`'s `push` deliberately avoids two credential-exposure paths a naive implementation would hit: it never calls `git remote set-url` with a token embedded in the URL (persists to `.git/config` indefinitely, well past the token's ~1hr expiry) and never passes a token-embedded URL as an argv argument (visible to any other process reading this process's arguments). The Authorization header goes through `GIT_CONFIG_*` environment variables instead, scoped to that one invocation.

`vercel-deploy.ts domain-check` queries Vercel's own `/v6/domains/{domain}/config` endpoint rather than resolving DNS and comparing against a hardcoded target — Vercel assigns each project a *unique* per-project CNAME, so a single hardcoded "expected value" would have been wrong for most real domains. (An earlier `dns-check.ts` that did its own DNS resolution was removed for exactly this reason.)

Two infrastructure utilities, not secret-bearing:

- **`server-lifecycle.ts`** — shared start/stop for a local site server, used by both design-agent (`--mode dev`, screenshot capture) and qa-agent (`--mode build`, adversarial audit). Fixed port, kills anything already bound to it before starting, writes a pidfile only once serving is confirmed, guarantees cleanup even on failure. `stop` takes no arguments at all — it only ever kills the PID its own pidfile recorded, so the precision of "which process to kill" lives in the script, not in something a hook has to parse out of an arbitrary command.
- **`a11y-audit.ts`** — `@axe-core/playwright` wrapper for qa-agent's accessibility pass. Runs under `node`, not `bun` (see "Commands" above).

### Compliance constraints baked into the schema/spec (not just convention)

- **AI-generated imagery**: `kickoff.json`'s `content_inventory` items cannot combine `represents_real_subject: true` with `media_source: "ai_generated"` — rejected at the schema level, not just by instruction. Never generate a photorealistic stand-in for something a customer would assume is a real photo (team photo, storefront).
- **Google Places API ToS**: `place_id` may be cached indefinitely, lat/lng for 30 days, but review text/ratings/author photos may **not** be persisted long-term. `scraper-output.json` only ever stores `places_place_id` + aggregate stats; individual review samples go only into the ephemeral, git-ignored `scraper-cache/` preview file, never the committed schema. The same review text is fetched live (never persisted) again by backend-agent's deployed reviews section, behind a required short-TTL edge cache.
