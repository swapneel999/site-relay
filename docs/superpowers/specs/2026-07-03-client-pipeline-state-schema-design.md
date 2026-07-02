# Client Pipeline State Schema — Design

Date: 2026-07-03

## Purpose

Design the shared spec/status file set that every subagent (scraper, design, backend, QA, integration lead) reads from and writes to while building a single client's website, end to end. This is the coordination substrate the pipeline runs on: it must let any agent invoked at any point know what's already been done, what it owns, and what it's allowed to touch.

## Overall Architecture

**Storage**: a `.pipeline/` directory committed inside each client's own repo, alongside their site code. Not a separate orchestration store — state travels with the repo, versioned in the same git history.

**Layout**:
```
.pipeline/
  kickoff.json
  scraper-output.json
  design-lock.json
  mockup-approval.json
  qa-report.json
  signoff.json
  pipeline-status.json
  qa/screenshots/round-{n}/*.png
  mockup/screenshots/round-{n}/*.png
```

One JSON file per pipeline stage/concern (not one giant file), so ownership per agent is clear and diffs stay readable in git. A separate git-ignored, regenerated-every-run cache (`.pipeline/scraper-cache/places-reviews-preview.json`) holds ephemeral Places-sourced review previews for design mockups — see scraper-output.json below.

**Format**: JSON, validated by JSON Schema.

**Concurrency model**: strictly sequential. Only one agent is active per client at a time; there is no file-locking or concurrent-write concern to design for.

**Shared envelope**: every file wraps its content identically:
```json
{
  "schema_version": "1.0",
  "client_id": "string",
  "last_updated_at": "timestamp",
  "last_updated_by": "string (agent identifier)",
  "data": { ... }
}
```

## Pipeline Stages

Fixed enum, tracked in `pipeline-status.json.current_stage`:

```
kickoff → scraping → design_homepage → mockup_review → mockup_revision (loops to mockup_review)
  → design_locked → design_remaining_pages → backend_build → qa → qa_revision (loops to qa)
  → integration_signoff → complete
```

Plus `blocked_needs_human`, reachable from either revision loop when its cap is exceeded, or from `integration_signoff` when a kick-back is required but no QA rounds remain.

**pipeline-status.json**:
```json
"data": {
  "current_stage": "string (enum above)",
  "blocked": "boolean",
  "blocked_reason": "string | null",
  "mockup_revision_round": "number (mirrors mockup-approval.json.current_round; orchestrator copies it here after each round closes)",
  "mockup_revision_cap": 3,
  "qa_revision_round": "number (mirrors qa-report.json.current_round; orchestrator copies it here after each round closes)",
  "qa_revision_cap": 2,
  "stage_history": [
    {"stage": "string", "entered_at": "timestamp", "exited_at": "timestamp | null", "agent": "string"}
  ]
}
```

Revision caps are fixed system-wide (not tier-dependent): mockup 3 rounds, QA 2 rounds. When a human unblocks a halted pipeline, they do so by directly editing `pipeline-status.json` (resetting `blocked`, adjusting a round/cap as needed) — there's no separate override file; the state file is the single source of truth.

## Cross-Cutting Conventions

- **Finding/feedback categories**: `visual | content | functional | integration` — used by both `mockup-approval.json` and `qa-report.json` to auto-route fixes: visual/content → design agent, functional/integration → backend agent.
- **QA severity**: `blocker | major | minor`.
- **Revision-round pattern**: both `mockup-approval.json` and `qa-report.json` keep an authoritative `current_round` counter plus a `rounds`/`review_rounds` array recording full history (never just the latest state) — screenshots referenced by relative path into the matching `.pipeline/*/screenshots/round-{n}/` folder.
- **Write ownership is explicit per file** — documented in full in `docs/spec.md`, summarized per section below.
- **Field-level formats**: `timestamp` = ISO 8601 UTC (e.g. `2026-07-03T14:22:00Z`); `hex` colors = `#RRGGBB`; `url` = absolute URL; `id` fields are opaque strings, unique within their containing file (not globally).

## File-by-File Design

### 1. kickoff.json — human/client intake, read by every agent

```json
"data": {
  "primary_contact": {"name": "string", "email": "string", "role": "string"},
  "languages": ["string"],
  "business": {
    "name": "string", "legal_name": "string | null", "industry": "string",
    "description": "string", "founded_year": "number | null",
    "existing_website_url": "string | null", "social_profiles": ["url"],
    "google_business_profile_url": "string | null",
    "locations": [{"address": "string", "phone": "string", "hours": "string"}]
  },
  "goals": {"primary_conversion_goal": "string", "secondary_goals": ["string"]},
  "content_inventory": [
    {
      "page": "string", "sections": ["string"],
      "text_source": "client_provides | needs_writing | scraper_sourced",
      "media_source": "client_provides | needs_sourcing | scraper_sourced",
      "notes": "string | null"
    }
  ],
  "design_direction": {
    "style_words": ["string"], "avoid": ["string"], "reference_sites": ["url"],
    "brand_assets": {"logo_url": "string | null", "existing_colors": ["hex"], "existing_fonts": ["string"]}
  },
  "functional_requirements": {
    "forms": [{"name": "string", "fields": ["string"], "destination_email": "string | null"}],
    "payments": {"required": "boolean", "provider": "string | null"},
    "cms": {"required": "boolean", "type": "string | null"},
    "scheduling": {"required": "boolean", "provider": "string | null"},
    "live_chat": {"required": "boolean", "provider": "string | null"},
    "newsletter": {"required": "boolean", "provider": "string | null"},
    "integrations": ["string (catch-all for anything without dedicated structure)"]
  },
  "constraints": {
    "domain": "string | null", "timeline_deadline": "date | null",
    "budget_tier": "starter | standard | premium",
    "compliance": {"accessibility_level": "none | AA | AAA", "privacy_regime": "none | GDPR | CCPA | both"}
  },
  "acceptance_criteria": [{"criterion": "string", "verification_method": "string"}]
}
```

`budget_tier` informs scope expectations only — it does not affect revision-round caps, which are fixed system-wide.

**Write ownership**: written once at kickoff (human/intake process); read-only for all agents thereafter.

### 2. scraper-output.json — normalized data regardless of source

Every leaf value uses a `SourcedField<T>` wrapper: `{value, source: own_site|places_api|web_search|not_found, confidence: verified|inferred|missing}`.

```json
"data": {
  "scrape_mode": "own_site | places_api | web_search",
  "completeness": "good | partial | poor",
  "business_info": {
    "name": "SourcedField<string>", "address": "SourcedField<string>",
    "phone": "SourcedField<string>", "hours": "SourcedField<string>",
    "categories": "SourcedField<string[]>", "price_level": "SourcedField<string>"
  },
  "reviews": {
    "aggregate_rating": "SourcedField<number>", "review_count": "SourcedField<number>",
    "places_place_id": "SourcedField<string>",
    "live_display": {
      "mode": "live_fetch | none", "max_results": "number", "sort": "most_recent | highest_rated",
      "note": "Places-sourced review text/ratings/author photos must be fetched live at render/request time by the backend agent's implementation. Only place_id is persisted here (allowed indefinitely under Places API ToS) — review content itself is never stored long-term in this file."
    },
    "own_site_testimonials": [
      {"author": "string", "rating": "number | null", "text": "string", "date": "string | null"}
    ]
  },
  "content_found": [
    {
      "page_guess": "string", "url": "string | null",
      "source": "own_site | web_search",
      "reuse_safe": "boolean (true = client's own words, safe verbatim; false = third-party text, must be rewritten)",
      "text_blocks": ["string"],
      "images": [{"url": "string", "alt_text": "string | null"}]
    }
  ],
  "social_profiles_found": ["url"],
  "scrape_notes": ["string"]
}
```

**Compliance note**: Google Places API ToS permits caching `place_id` indefinitely and lat/lng for 30 days, but not review content. Review text, ratings, and author photos (`author_photo_url`, `author_profile_url` — a `PlacesReviewSample` shape documented in `docs/spec.md`) are fetched live at render/request time by the backend agent's implementation, never baked into `scraper-output.json`. A separate git-ignored, regenerated-every-run file at `.pipeline/scraper-cache/places-reviews-preview.json` may hold placeholder review samples purely so the design agent has realistic content to lay out the testimonials section before live-fetch is wired up — this cache is outside the committed JSON Schema and never persisted long-term.

`completeness` lets the orchestrator halt to `blocked_needs_human` if a scrape mostly failed, rather than letting garbage flow into design.

**Write ownership**: written once by the scraper agent; read-only for all downstream agents.

### 3. design-lock.json — locked once homepage mockup is approved

```json
"data": {
  "tokens": {
    "colors": {
      "primary": "hex", "secondary": "hex", "accent": "hex", "background": "hex", "surface": "hex",
      "text_primary": "hex", "text_secondary": "hex", "text_on_primary": "hex", "text_on_secondary": "hex",
      "border": "hex", "success": "hex", "warning": "hex", "error": "hex"
    },
    "typography": {
      "heading_font": "string", "body_font": "string",
      "scale": {"h1": "string", "h2": "string", "h3": "string", "body": "string", "small": "string"}
    },
    "spacing_scale": ["string"], "radius": "string", "shadow_style": "string", "imagery_style": "string",
    "breakpoints": {"mobile": "px", "tablet": "px", "desktop": "px"}
  },
  "component_catalog": [
    {
      "pattern": "string", "library": "shadcn | reactbits", "component_name": "string",
      "file_path": "string (import path to the actual built component)",
      "variant_notes": "string | null", "added_at": "timestamp",
      "added_during": "homepage | remaining_pages"
    }
  ],
  "approved_homepage_mockup_ref": "string",
  "approved_mockup_revision_round": "number (the mockup_revision_round this lock was derived from)"
}
```

Contrast-pairing tokens (`text_on_primary`, `text_on_secondary`, `border`) exist specifically so QA can verify contrast ratios against `kickoff.json`'s `accessibility_level`. `breakpoints` exists so QA's responsive checks use this client's actual breakpoints, not generic assumptions.

**Policies**:
- `component_catalog` is **append-only** — the single source of truth QA checks new patterns against. Design agent appends entries as it encounters new patterns building remaining pages (`added_during: "remaining_pages"`).
- Any post-lock client-requested design change forces a **full return to `mockup_revision`** (consuming a round against its cap of 3); `design-lock.json` is regenerated from the newly approved homepage. No narrower amendment path.

**Write ownership**: written once by the design agent at homepage approval; appended to by the design agent during `design_remaining_pages`; read-only for all other agents.

### 4. mockup-approval.json — client feedback on the homepage mockup

```json
"data": {
  "status": "pending | changes_requested | approved",
  "current_round": "number (authoritative; orchestrator copies into pipeline-status.json after each round closes)",
  "rounds": [
    {
      "round": "number", "mockup_ref": "string", "submitted_at": "timestamp",
      "feedback_items": [
        {
          "id": "string", "page": "string", "element": "string",
          "screenshot_ref": "string", "annotation_coords": "{x,y,width,height} | null",
          "requested_change": "string",
          "category": "visual | content | functional | integration",
          "deferred_to_stage": "string | null (e.g. 'backend_build', set when category is functional/integration)",
          "status": "open | addressed | wont_fix",
          "agent_note": "string | null"
        }
      ],
      "decided_at": "timestamp | null",
      "decided_status": "changes_requested | approved | null"
    }
  ]
}
```

Functional/integration feedback raised during mockup review isn't dropped just because backend hasn't started — it's tagged `deferred_to_stage` and picked up later.

**Write ownership**:
- **Feedback ingestion** (orchestrator/human intake): creates rounds, populates `feedback_items` (`status: open`), sets `deferred_to_stage`, sets `decided_status`/`decided_at`.
- **Design agent**: may only update `status`/`agent_note` on existing items it owns (visual/content). Never creates/removes rounds or sets decisions.
- **Backend agent**: during `backend_build`, picks up `open` items with `deferred_to_stage: "backend_build"`, same update-only permissions.

Cap: 3 rounds. Exceeding it → `blocked_needs_human`.

### 5. qa-report.json — QA agent's structured audit, its one write target

```json
"data": {
  "overall_status": "pass | fail",
  "current_round": "number (authoritative; orchestrator copies into pipeline-status.json after each round closes)",
  "rounds": [
    {
      "round": "number", "scope": "full", "tested_at": "timestamp",
      "findings": [
        {
          "id": "string", "reopened_from_id": "string | null",
          "page": "string", "issue": "string",
          "severity": "blocker | major | minor",
          "category": "visual | content | functional | integration",
          "screenshot_ref": "string | null",
          "status": "open | fixed_claimed | disputed | verified_fixed | wont_fix | superseded",
          "agent_note": "string | null"
        }
      ],
      "acceptance_criteria_check": [
        {"criterion": "string", "verification_method": "string", "verified": "boolean", "note": "string | null"}
      ],
      "round_result": "pass | fail (descriptive/audit only — not load-bearing for overall_status)"
    }
  ]
}
```

`scope` is always `"full"` — every round re-checks the entire site to catch regressions.

**Status lifecycle** (no agent can self-dismiss its own findings):
- A finding starts `open`.
- The agent assigned by `category` (design: visual/content, backend: functional/integration) may only move it to `fixed_claimed` or `disputed` (with `agent_note`).
- On the next round, QA re-checks and sets exactly one of: `verified_fixed`, `wont_fix`, or creates a new finding with `reopened_from_id` pointing back to the original — and in that same action sets the original's status to `superseded`. `superseded` findings are permanently excluded from the unresolved check; only the live chain-tip counts.
- A round closes once every finding has an agent response (`fixed_claimed`/`disputed`) or the round cap (2) is hit — whichever first — triggering the next QA round.

**`pass_condition`** (two deliberately different scopes):
- **Findings**: across every finding in every round to date, excluding `superseded` — no finding with severity `blocker` in status `{open, disputed, fixed_claimed}`.
- **Acceptance criteria**: the **current round's** `acceptance_criteria_check[]` only (each round re-verifies fresh, `scope: full`, no cross-round linking) — all entries `verified == true`.

```
overall_status = "pass" when pass_condition is true
otherwise:
  - if cap NOT hit: stay in "qa_revision"
  - if cap hit: → blocked_needs_human
```

Cap-hit is not separate logic — it's the same `pass_condition`, just with no rounds left if it fails.

**Write ownership**: QA agent is the **only** writer of this file (creates rounds, findings, `acceptance_criteria_check`, `round_result`) — consistent with its read-only-elsewhere mandate. Design/backend agents may only update `status`/`agent_note` on findings assigned to them via `category`, and only to `fixed_claimed`/`disputed` — never `wont_fix`, `verified_fixed`, or `superseded`, which are QA-exclusive.

### 6. signoff.json — integration lead's final gate

```json
"data": {
  "current_round": "number",
  "review_rounds": [
    {
      "round": "number", "reviewed_at": "timestamp",
      "checklist": {
        "repo_pushed": "boolean", "preview_deploy_live": "boolean",
        "dns_domain_configured": "boolean | n/a", "env_vars_configured": "boolean"
      },
      "unresolved_majors": [
        {
          "qa_finding_id": "string (a qa-report.json finding, severity major, status in {open, disputed, fixed_claimed})",
          "page": "string", "issue": "string",
          "category": "visual | content | functional | integration",
          "decision": "ship_anyway | kick_back_to_qa", "decision_note": "string | null"
        }
      ],
      "client_final_approval": {
        "status": "pending | approved | changes_requested",
        "approved_at": "timestamp | null", "approved_by": "string | null", "notes": "string | null",
        "requested_changes": [
          {"page": "string", "issue": "string", "category": "visual | content | functional | integration", "client_flagged_blocking": "boolean"}
        ]
      },
      "round_outcome": "promoted | returned_to_qa | pending"
    }
  ],
  "repo_url": "string", "preview_deploy_url": "string", "production_url": "string | null",
  "production_promotion_status": "not_promoted | promoted"
}
```

`qa_passed`/`acceptance_criteria_verified` are deliberately **not** duplicated here — the integration lead reads `qa-report.json.overall_status` and its current round's `acceptance_criteria_check` directly at review time.

`client_final_approval` is the **second** human checkpoint (distinct from early mockup approval): the client's review of the complete, QA-passed site before it goes live. `requested_changes` is raw client input only, never a finding — authorship of findings stays QA's exclusive right (per file 5). When routing back to `qa_revision`, the QA agent is invoked with `requested_changes` as context for its next full-scope round and authors the resulting `qa-report.json` findings itself.

**Round closing** (a new `review_rounds` entry begins each time `integration_signoff` is re-entered):
- → **`promoted`**: all `checklist` items `true`/`n/a` AND all `unresolved_majors[].decision == ship_anyway` AND `client_final_approval.status == approved`.
- → **`returned_to_qa`**: any `unresolved_majors[].decision == kick_back_to_qa`, OR `client_final_approval.status == changes_requested`. Both consume a round from QA's existing cap (no separate cap); if that cap is already exhausted, routes to `blocked_needs_human` instead.

**Write ownership**:
- **Integration lead agent**: writes `checklist` and each `unresolved_majors[].decision`/`decision_note`. Never writes `client_final_approval`.
- **Client-approval intake** (human/orchestrator): the only writer of `client_final_approval.status`/`approved_at`/`approved_by`/`notes`/`requested_changes`.

## Agent Read/Write Matrix (summary)

| File | Written by | Read by |
|---|---|---|
| kickoff.json | human/intake (once) | all agents |
| scraper-output.json | scraper agent (once) | design, backend, QA |
| design-lock.json | design agent (write once + append during remaining_pages) | design, backend, QA, integration lead |
| mockup-approval.json | intake (rounds/decisions), design (status on visual/content), backend (status on deferred functional/integration) | design, integration lead |
| qa-report.json | QA agent (exclusive) except `status→fixed_claimed/disputed` by design/backend on assigned findings | design, backend, integration lead |
| signoff.json | integration lead (checklist/decisions), client intake (client_final_approval) | — |
| pipeline-status.json | orchestrator (stage transitions, round mirrors) | all agents (first read on invocation) |

## Out of Scope

- Multi-tenant orchestration layer itself (how agents get invoked, queued, scheduled) — this design only covers the state files they share.
- Concurrency/locking — ruled out by the strictly-sequential model.
- Schema migration tooling for `schema_version` bumps — noted as a future concern, not designed here.
