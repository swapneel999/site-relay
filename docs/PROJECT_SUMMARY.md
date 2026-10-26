# Project Summary — Website Builder Pipeline

This is a narrative overview of what this repository is, how it's put together, and why it's built the way it is. For the authoritative field-by-field reference, see [`docs/spec.md`](./spec.md); for the terse operating instructions Claude Code itself reads, see [`CLAUDE.md`](../CLAUDE.md). This document is for anyone (human or agent) who wants the *why* behind the structure without re-deriving it from the schemas and agent files directly.

## What this is

A multi-tenant, multi-agent pipeline for building small-business client websites. One fictitious client (`acme-co`, used consistently across every test fixture) stands in for what a real client's journey through the pipeline looks like. There is **no live client and no orchestrator implementation yet** — this repo is the *contract*: JSON Schemas, five subagent definitions, the hooks that mechanically enforce their write boundaries, and the CLI scripts those agents call out to.

Each client moves through a fixed sequence of stages:

```
kickoff → scraping → design_homepage → mockup_review → mockup_revision →
design_locked → design_remaining_pages → backend_build → qa → qa_revision →
integration_signoff → complete
```

...with a `blocked_needs_human` escape hatch reachable from a revision loop whose round cap is exceeded, or from `integration_signoff` when a kick-back is required but no QA rounds remain.

## The core idea: a shared JSON contract, not shared code

Every stage hands off to the next entirely through a small set of JSON files under a per-client `.pipeline/` directory. Every one of those files wraps its payload in the same envelope — `{ schema_version, client_id, last_updated_at, last_updated_by, data: {...} }` — and validates against a draft-07 JSON Schema in `schemas/`. Agents never call each other directly; they read whatever the previous stage left behind and write their own slice, and the schema is the interface between them.

There are seven such files, each with exactly one owner or a narrow, explicit split:

| File | Owner |
|---|---|
| `kickoff.json` | human/intake, once — read-only forever after |
| `scraper-output.json` | scraper agent, once |
| `design-lock.json` | design agent |
| `mockup-approval.json` | split: intake creates rounds; design/backend update their own items |
| `qa-report.json` | QA agent, almost exclusively |
| `signoff.json` | split: integration lead vs. client-approval intake |
| `pipeline-status.json` | orchestrator only |

The concurrency model is deliberately simple: exactly one agent is active per client at a time, so there's no file-locking and no race to design around. That simplicity is a stated tradeoff (it gives up running design and backend in parallel), not an oversight — and it does not relax any of the write-ownership rules above, which exist for audit integrity, not to prevent collisions.

## The five agents

Five subagents move a client through the pipeline, each with a `.claude/agents/<name>.md` definition, a scoped `tools` list, and (except where noted) a `PreToolUse` hook in `scripts/hooks/` that enforces its write boundary mechanically rather than by instruction alone.

1. **scraper-agent** — runs once, before any design work. Gathers business data (the client's own site, Google Places, web search) into `scraper-output.json`. Its hook is an allow-list: exactly one real output file plus an ephemeral, git-ignored review cache, and `Bash` restricted to its own lookup script.

2. **design-agent** — builds the actual Next.js site. Runs across four different modes depending on pipeline stage: the first homepage build, addressing client mockup feedback, building out the rest of the site after the homepage locks, and fixing visual/content QA findings. Owns `design-lock.json` (design tokens, component catalog, generated-image ledger) and its slice of `mockup-approval.json`/`qa-report.json`. Its hook is a deny-list — building a site needs broad file access, so four specific pipeline files are blocked instead.

3. **backend-agent** — wires the functional side (payments, scheduling, CMS, forms, integrations, live reviews) into the UI design-agent already built; never creates new UI. Its hook is design-agent's deny-list plus one more protected file (`design-lock.json` — backend reads it, never writes it). The credentials model here was a deliberate decision, not a default: every integration is client-owned by default (the client's own Stripe, own Mailchimp, own transactional-email account), with one narrow, explicitly-disclosed exception for the Places reviews live-fetch, which reuses the scraper's shared key under a required short-TTL cache.

4. **qa-agent** — the one agent structurally incapable of being wrong in its own favor: only QA can confirm a finding fixed, dismiss it, or mark a reopened finding's predecessor superseded. Runs a real adversarial audit (click everything, submit every form valid and invalid, screenshot every breakpoint, run an accessibility scan) against a local **production build** — never a dev server, since dev-mode fast-refresh can mask exactly the kind of defect a real visitor would hit. Its hook is the narrowest allow-list in the pipeline, and its write-pattern invariant is its own design, not reused from design/backend: a finding that reaches a terminal status (`verified_fixed`/`wont_fix`/`superseded`) is frozen in **every** field, not just its status, and a round that's no longer current is frozen entirely except for the one legitimate reconciliation QA still does to it later.

5. **integration-lead-agent** — the last agent before `complete`, and the first whose write is more than a local file. Pushes the final, QA-passed code to GitHub (the *only* push in the whole pipeline — see below for why it's consolidated here), verifies a pre-launch checklist (repo pushed, preview live, domain configured, env vars present), triages any still-unresolved major QA findings, and executes the actual production promotion once the client's own final approval has been separately recorded. Never creates a repo or Vercel project, never touches site code — it verifies and promotes, it doesn't fix.

## Why the GitHub push lives in one place, not three

An early design question was where code actually gets pushed to GitHub, since three different agents (design, backend, QA-revision fixes) all modify site code across the pipeline. Tracing through what each agent's *own testing* actually requires resolved it: design-agent's screenshot capture and QA's adversarial audit both run against a **local** dev/build server (`scripts/server-lifecycle.ts`) — neither one needs the code to have ever left the machine. The only things that need the code actually on GitHub are integration-lead's own pre-launch checklist and the client's real preview/production experience. So the push happens exactly once, immediately before that checklist — not incrementally from three separately-credentialed agents, which would have meant handing GitHub write access to the two agents that already carry the broadest tool access in the whole pipeline. Design-agent and backend-agent are still expected to commit their own work as ordinary git hygiene (they already have unrestricted `Bash`); integration-lead assumes a clean, already-committed tree and pushes it, but never commits on their behalf.

## Client onboarding: a human step, not an agent

Before any agent ever runs for a client, someone runs `scripts/onboard-client.ts` once, by hand, alongside authoring `kickoff.json`. This isn't a sixth agent — it's a small CLI script with no hook and no Claude Code frontmatter, because repo/project creation is fundamentally a one-time, human-mediated action:

- The client creates one empty GitHub repo in their own account (personal or org — either works) and installs the agency's GitHub App scoped to just that repo. **GitHub Apps cannot create repositories in a personal account via an installation token at all** — a hard API restriction discovered through research, not assumed from documentation — which is why the client creates the repo first and the App only ever verifies access and pushes, never creates.
- The client creates their own Vercel project and hands the agency a project-scoped deploy token.
- `onboard-client.ts` verifies the App can see the repo, pushes the initial scaffold, creates the linked Vercel project, and registers the client in `clients.json` — the agency-level registry (not under `.pipeline/`, deliberately no JSON Schema) that exists specifically so a shared-secret rotation can enumerate every client's deployment, including ones still mid-build. Registering only at final signoff, as an earlier draft of this design did, would have left every in-flight client invisible to that rotation runbook for the entire build duration — exactly the failure mode the registry exists to prevent.

Every credential in this pipeline follows the same shape as this onboarding decision: **client-owned by default**, agency access granted narrowly and revocably (a GitHub App installation the client can revoke unilaterally, a Vercel token scoped to one project), not an agency-wide account that becomes a single point of failure across every client at once. The one deliberate exception is the Places API key, reused from scraping through to the deployed site's live reviews section, because it's a read-only key against public data rather than a client-specific account — and even that exception ships with a documented rotation runbook rather than being silently accepted as a permanent posture.

## How write boundaries are actually enforced

Every stated boundary in this project is backed by a real `PreToolUse` hook, not prose an agent could choose to ignore. Two models are used, deliberately:

- **Deny-list** (design-agent, backend-agent): broad access is unavoidable since building the site *is* the job, so a short, fixed list of files is blocked instead.
- **Allow-list** (scraper-agent, qa-agent, integration-lead-agent): the legitimate surface is narrow enough to enumerate exhaustively, so anything unmatched is rejected by default — a strictly stronger guarantee.

Beyond simple file-path gating, several hooks enforce content-level invariants by diffing old vs. new JSON before allowing a write: round counts and finding counts are append-only everywhere rounds exist, and — QA's own addition to this pattern — a finding that reaches a terminal status is frozen in every field forever, including against QA's own future writes. Integration-lead's hook goes one step further: an entire review round is frozen once a later round exists, and `client_final_approval` is frozen from integration-lead's own writes in every round, current or not, since that field belongs exclusively to a different, separate process (client-approval intake).

## Secrets and external services

Every third-party API key is read exactly once, by a small CLI wrapper script, from that script's own process environment — never by an agent directly, and never echoed or logged:

| Script | Secret | Used by |
|---|---|---|
| `places-lookup.ts` | `GOOGLE_PLACES_API_KEY` | scraper-agent |
| `generate-image.ts` | `GEMINI_API_KEY` | design-agent |
| `github-repo.ts` | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | `onboard-client.ts`, integration-lead-agent |
| `vercel-deploy.ts` | `VERCEL_TOKEN` | `onboard-client.ts`, integration-lead-agent |

This project treats "matches the documented API shape" as insufficient evidence that something works — every wrapper script has either been live-tested against a real account, or is explicitly, prominently marked as unverified with the exact reason why, rather than silently assumed correct. Two real incidents came out of holding that line: `generate-image.ts`'s first live call revealed the model actually returns `image/jpeg`, not the `image/png` its documentation implied; and `a11y-audit.ts` (the accessibility scanner) turned out to hang indefinitely under Bun's process/WebSocket handling on this machine specifically, resolved by running that one script under Node instead — documented as the one deliberate exception to this repo's otherwise all-Bun convention. `github-repo.ts` and `vercel-deploy.ts` remain honestly unverified as of this writing, since no GitHub App or Vercel account exists in this environment to test against — that gap is written down explicitly in both scripts' headers and in integration-lead-agent's own doc, rather than glossed over.

## Testing

`bun test` runs everything. Every schema has a valid/invalid fixture pair (`tests/schemas/fixtures/<name>/`), checked with `ajv`; a cross-file test confirms every fixture uses the same fictitious client ID so the "full pipeline" stays internally consistent. Every agent has a self-skipping dry-run test (`tests/agents/<name>-output.dry-run.test.ts`) that passes trivially until a real agent run produces output, then validates that real output against schema. Every hook has its own unit test suite spawning the hook script as a subprocess and feeding it synthetic `PreToolUse` payloads — allowed shapes, blocked shapes, and the content-invariant edge cases (round drops, terminal-finding tampering, non-current-round writes) that matter most.

## What's not built yet

There is no orchestrator — nothing in this repo actually advances `pipeline-status.json.current_stage` or invokes agents in sequence; that's assumed to be a human or a future system driving the `Agent` tool directly. There's no live client. `github-repo.ts` and `vercel-deploy.ts` need a real sandbox test before the first real client goes through onboarding. And the accepted-risk posture on the shared `GOOGLE_PLACES_API_KEY` (a raw key in every deployment rather than a centralized proxy) is explicitly flagged for revisit once an orchestrator/deployment pipeline actually exists to support standing up that additional infrastructure.
