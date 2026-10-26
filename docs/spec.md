# Client Pipeline State Schema — Reference

Source design: `docs/superpowers/specs/2026-07-03-client-pipeline-state-schema-design.md`
Machine-checkable schemas: `schemas/*.schema.json` (draft-07, validated with `ajv` — see `tests/schemas/`)

This document is the field-by-field reference for every file in a client's `.pipeline/` directory: what each field means, who writes it, and who reads it. If this document and a `.schema.json` file ever disagree on *shape*, the schema is authoritative (it's machine-checked); if either disagrees with the design doc on *intent*, the design doc is authoritative and this file has drifted and needs fixing.

## Shared envelope

Every file wraps its content identically:

| Field | Meaning | Written by |
|---|---|---|
| `schema_version` | Schema version this file conforms to. Most files are `"1.0"`; `kickoff.json` and `scraper-output.json` are `"2.0"` as of the multi-location schema change (see `docs/superpowers/specs/2026-08-26-multi-location-schema-and-kickoff-validation-design.md`) — existing single-location clients were mechanically migrated, not left on a dual-shape schema. | Whoever last wrote the file. |
| `client_id` | Opaque identifier for this client, stable for the life of the project. | Set once at kickoff, never changed. |
| `last_updated_at` | ISO 8601 UTC timestamp of the last write. | Whoever last wrote the file. |
| `last_updated_by` | Agent identifier of the last writer (e.g. `"scraper-agent"`, `"orchestrator"`, `"human/intake"`). | Whoever last wrote the file. |
| `data` | The file-specific payload — see sections below. | Per-file write ownership rules below. |

**Field-level format conventions** (apply throughout): `timestamp` = ISO 8601 UTC (`2026-07-03T14:22:00Z`); hex colors = `#RRGGBB`; `url` = absolute URL; `id` fields are opaque strings unique within their containing file only (not globally unique across files).

## Pipeline stages (`pipeline-status.json`)

Schema: `schemas/pipeline-status.schema.json`

Fixed stage sequence:

```
kickoff → scraping → design_homepage → mockup_review → mockup_revision (loops to mockup_review)
  → design_locked → design_remaining_pages → backend_build → qa → qa_revision (loops to qa)
  → integration_signoff → complete
```

Plus `blocked_needs_human`, reachable from either revision loop when its cap is exceeded, or from `integration_signoff` when a kick-back is required but no QA rounds remain.

| Field | Meaning | Written by | Read by |
|---|---|---|---|
| `current_stage` | Which stage the pipeline is in right now — the 12 stages above plus `blocked_needs_human`. | Orchestrator, on every stage transition. | Every agent, on invocation — this is how an agent knows what state it's picking up. |
| `blocked` | `true` if the pipeline has halted for human intervention. | Orchestrator. | Every agent (checked before doing any work). |
| `blocked_reason` | Free-text explanation of why, or `null` if not blocked. | Orchestrator. | Human operator; every agent. |
| `mockup_revision_round` | Mirror of `mockup-approval.json`'s `current_round`, copied here by the orchestrator once that round closes. Not independently incremented — `mockup-approval.json` is authoritative; this is a read-convenience copy. | Orchestrator (copy-only, after round closes). | Every agent, as a cheap way to check round count without opening `mockup-approval.json`. |
| `mockup_revision_cap` | Fixed at `3`. Not tier-dependent — `kickoff.json`'s `budget_tier` does not affect this. | Never — a schema constant. | Orchestrator (to decide `blocked_needs_human`). |
| `qa_revision_round` | Mirror of `qa-report.json`'s `current_round`, same copy-only pattern as `mockup_revision_round`. | Orchestrator (copy-only, after round closes). | Every agent. |
| `qa_revision_cap` | Fixed at `2`. | Never — a schema constant. | Orchestrator. |
| `stage_history` | Append-only log of every stage entered: `{stage, entered_at, exited_at (null while current), agent}`. | Orchestrator, appends one entry per transition. | Anyone auditing the pipeline's timeline. |

**Unblocking**: a human unblocks a halted pipeline by directly editing `pipeline-status.json` (resetting `blocked`, adjusting a round/cap if needed). There is no separate override file — this file is the single source of truth.

## 1. `kickoff.json` — human/client intake

Schema: `schemas/kickoff.schema.json`

**Write ownership**: written once at kickoff by the human/intake process. Read-only for every agent thereafter — no agent ever modifies this file.

| Field | Meaning |
|---|---|
| `primary_contact.{name,email,role}` | Who the pipeline/agents should treat as the client's point of contact. |
| `languages` | Site languages, at least one. First entry is the primary/default language. |
| `business.name` / `legal_name` | Display name vs. registered legal name (may differ, e.g. DBA). |
| `business.existing_website_url` | If set, this is the **first signal** the scraper agent checks — presence of this field selects `scrape_mode: own_site`. |
| `business.social_profiles` | Known social URLs, seeded into the scraper's search even before it starts crawling. |
| `business.google_business_profile_url` | If set (and `existing_website_url` isn't), selects `scrape_mode: places_api`. |
| `business.locations` | One or more physical locations; each a `{location_id, address, phone, hours}` object. `location_id` is a kebab-slug (`common.schema.json#/$defs/locationId`), opaque and unique only within this file — it's the correlation key `scraper-output.json`'s per-location arrays match back against, chosen explicitly over positional/array-index matching so structured business facts (address, phone, live review data) stay correctly paired even if this array is ever reordered. |
| `goals.primary_conversion_goal` | The one thing the site should get a visitor to do — informs CTA placement/copy for design. |
| `content_inventory[]` | Per-page/section plan for where text and media come from. |
| `content_inventory[].text_source` | `client_provides` (client will supply copy) \| `needs_writing` (someone must write it — design/backend agent's job) \| `scraper_sourced` (pull it from the scrape). |
| `content_inventory[].media_source` | Same idea for images/video, plus `ai_generated` (Gemini Nano Banana). |
| `content_inventory[].represents_real_subject` | `true` when the image/video stands in for something specific and real (team photo, storefront, actual product) — as opposed to decorative/illustrative content. **Enforced constraint**: an item can never have `represents_real_subject: true` together with `media_source: ai_generated` — the schema's `content_inventory` items reject that combination outright (see "AI-generated imagery policy" below). |
| `design_direction.style_words` / `avoid` | Adjectives to aim for / avoid — direct input to the design agent's first mockup pass. |
| `design_direction.brand_assets` | Pre-existing brand material (logo, colors, fonts) the design agent must incorporate, not invent. |
| `functional_requirements.forms[]` | Each form's fields and where submissions should be emailed. |
| `functional_requirements.{payments,cms,scheduling,live_chat,newsletter}` | Each a `{required, provider}` pair — `provider` is a hint (e.g. `"Calendly"`), not a guarantee of which integration gets built. |
| `functional_requirements.integrations` | Catch-all string list for anything without dedicated structure above. |
| `constraints.budget_tier` | `starter \| standard \| premium` — informs scope expectations only. **Does not** change revision-round caps, which are fixed system-wide (see `pipeline-status.json`). |
| `constraints.compliance.accessibility_level` | `none \| AA \| AAA` — what QA checks contrast/semantics against, using `design-lock.json`'s `text_on_primary`/`text_on_secondary`/`border` tokens. |
| `acceptance_criteria[]` | `{criterion, verification_method}` pairs QA re-verifies every round in `qa-report.json`'s `acceptance_criteria_check`. |

**AI-generated imagery policy**: when `represents_real_subject` is `true`, `media_source` may never be `ai_generated` — a customer reasonably assumes a "team photo" or "storefront photo" is real, and generating a photorealistic stand-in for it is a trust problem, not a content-sourcing solution. AI generation is only appropriate for illustrative/decorative content or abstract hero graphics — never as a substitute for a specific real thing the client hasn't provided. The design agent should refuse or escalate any `content_inventory` item that would violate this (the schema also rejects it outright at the data-shape level).

## 2. `scraper-output.json` — normalized data regardless of source

Schema: `schemas/scraper-output.schema.json`

**Write ownership**: written once by the scraper agent. Read-only for design, backend, and QA thereafter.

**`SourcedField<T>` wrapper**: every leaf business-info value is `{value, source, confidence}` — `source` is `own_site \| places_api \| web_search \| not_found`, `confidence` is `verified \| inferred \| missing`. This lets every downstream agent judge how much to trust a given fact without re-deriving provenance.

| Field | Meaning |
|---|---|
| `scrape_mode` | Which strategy produced this file — `own_site \| places_api \| web_search`, chosen by the scraper agent's fixed priority order (own site first, then Places, then web search — see `.claude/agents/scraper-agent.md` for the exact decision logic). |
| `completeness` | Scraper's self-assessment: `good \| partial \| poor`. Lets the orchestrator halt to `blocked_needs_human` if a scrape mostly failed, instead of letting garbage flow into design. |
| `business_info.{name,categories,price_level}` | Business-wide core facts, each a `SourcedField` — one value regardless of how many physical locations the business has. |
| `business_info.locations[]` | Per-location facts: `{location_id, address, phone, hours}`, each of the latter three a `SourcedField`. `location_id` matches the corresponding entry in `kickoff.json`'s `business.locations[]`. |
| `reviews.by_location[]` | One entry per physical location: `{location_id, aggregate_rating, review_count, places_place_id, live_display}` — each physical location has its own Google Business Profile, so these are never business-wide. `aggregate_rating`/`review_count`/`places_place_id` are each `SourcedField`s; `places_place_id` is the **only** Places-sourced review data persisted here, permitted indefinitely under Places API ToS. `live_display` is instructions for the backend agent's *implementation* for that specific location, not stored review content: `mode` (`live_fetch \| none`), `max_results`, `sort` (`most_recent \| highest_rated`). Review text, ratings, and author photos must be fetched live at render/request time, per location — never baked into this file. See the compliance note below for the `PlacesReviewSample` shape the backend agent's live-fetch code should use. |
| `reviews.own_site_testimonials[]` | Testimonials found directly on the client's own site (not Places-sourced) — these have no ToS restriction and are persisted in full: `{author, rating, text, date}`. |
| `content_found[]` | Raw text/image material discovered during the scrape, one entry per page found. |
| `content_found[].reuse_safe` | `true` = client's own words/photo, safe to use verbatim; `false` = third-party (`web_search`-sourced) content — must be rewritten (text) or must not be used without separate rights clearance (images). Applies per text block's containing item **and** per image individually (`content_found[].images[].reuse_safe`), since an item can mix own-site and third-party images. |
| `social_profiles_found` | Social URLs discovered during the scrape, distinct from `kickoff.json.business.social_profiles` (client-declared) — this is what the scraper actually found. |
| `scrape_notes` | Free-text notes for a human/orchestrator (e.g. "pricing page 404'd"). |

**Compliance note — Places API ToS**: `place_id` may be cached indefinitely; latitude/longitude for up to 30 days; review content (text, rating, author photo/profile) may **not** be persisted long-term. This is why only `places_place_id` appears in `scraper-output.json`'s committed schema. The live-fetch contract the backend agent implements against is a `PlacesReviewSample`:

```
PlacesReviewSample {
  author: string
  author_photo_url: string | null
  author_profile_url: string | null
  rating: number
  text: string
  relative_time_description: string   // e.g. "2 weeks ago", as returned live by the Places API
}
```

This shape is **not** part of any committed JSON Schema — it's fetched live, never stored, and documented here only so the backend agent's implementation has an exact contract to code against. A separate git-ignored, regenerated-every-run file at `.pipeline/scraper-cache/places-reviews-preview.json` may hold placeholder review samples purely so the design agent has realistic content to lay out the testimonials section before live-fetch is wired up in the real backend — this cache is outside the schema and never persisted long-term (it's regenerated every run and git-ignored).

## 3. `design-lock.json` — locked once homepage mockup is approved

Schema: `schemas/design-lock.schema.json`

**Write ownership**: written once by the design agent at homepage approval. Appended to (`component_catalog`, `generated_assets` only) by the design agent during `design_remaining_pages`. Read-only for backend, QA, and integration lead.

| Field | Meaning |
|---|---|
| `tokens.colors.*` | The locked color palette. `text_on_primary` / `text_on_secondary` / `border` exist specifically so QA can verify contrast ratios against `kickoff.json`'s `accessibility_level` — they're not decorative, they're QA's test input. |
| `tokens.typography.*` | Font choices and the `h1`–`small` size scale. `heading_font`/`body_font` are required; `label_font` is optional, for clients whose design uses a distinct third face for labels/metadata (e.g. hours, addresses) rather than reusing the body font. |
| `tokens.breakpoints` | This client's actual responsive breakpoints (`mobile`/`tablet`/`desktop`, in px) — QA's responsive checks use these, not generic assumptions. |
| `component_catalog[]` | **Append-only.** Every reusable component pattern built so far: `{pattern, library (shadcn\|reactbits), component_name, file_path, variant_notes, added_at, added_during (homepage\|remaining_pages)}`. This is the single source of truth QA checks new patterns against — a page using an undocumented pattern is a QA finding. |
| `approved_homepage_mockup_ref` | Path to the exact mockup screenshot that was approved — the visual source of truth this lock derives from. |
| `approved_mockup_revision_round` | Which `mockup-approval.json` round this lock corresponds to — lets you trace a lock back to the exact approved feedback state. |
| `generated_assets[]` | **Append-only**, same pattern as `component_catalog` — one entry per AI-generated image: `{file_path, prompt, model (nano_banana_flash\|nano_banana_pro), cost_usd, generated_at}`. Written by the design agent whenever it generates an image, subject to `kickoff.json`'s AI-generated imagery policy (never for `represents_real_subject: true` content). |

**Post-lock changes**: any client-requested design change after lock forces a full return to `mockup_revision` (consuming a round against its cap of 3); `design-lock.json` is regenerated from the newly approved homepage. There is no narrower amendment path — a lock is all-or-nothing.

**Implementation note (not a schema field)**: the Gemini API key requires its own Google Cloud billing setup via AI Studio — a consumer Gemini Pro subscription does not cover programmatic API usage. Store the key as an environment variable available to the design agent's tool access only; never in any committed pipeline file.

## 4. `mockup-approval.json` — client feedback on the homepage mockup

Schema: `schemas/mockup-approval.schema.json`

**Write ownership**:
- **Feedback ingestion** (orchestrator/human intake): creates rounds, populates `feedback_items` (starting `status: open`), sets `deferred_to_stage`, sets `decided_status`/`decided_at`.
- **Design agent**: may only update `status`/`agent_note` on existing items it owns (category `visual`/`content`). Never creates or removes rounds, never sets decisions.
- **Backend agent**: during `backend_build`, picks up `open` items with `deferred_to_stage: "backend_build"` — same update-only permissions as design.

Read by: design, backend, integration lead.

| Field | Meaning |
|---|---|
| `status` | Current approval state for the whole file: `pending \| changes_requested \| approved`. |
| `current_round` | Authoritative round counter — `pipeline-status.json.mockup_revision_round` is a copy of this, not the other way around. |
| `rounds[].feedback_items[].category` | `visual \| content \| functional \| integration` — auto-routes the fix: visual/content → design agent; functional/integration → backend agent. |
| `rounds[].feedback_items[].deferred_to_stage` | Set (e.g. `"backend_build"`) when `category` is functional/integration and backend hasn't started yet — the item isn't dropped, it's queued for when that stage runs. |
| `rounds[].feedback_items[].screenshot_ref` | **Required** (never null) — every client mockup comment is anchored via the annotation tool to a location on the page, so a screenshot always exists. Contrast with `qa-report.json`, where the equivalent field is nullable (QA can flag non-visual issues like console errors with nothing to screenshot). |
| `rounds[].feedback_items[].status` | `open \| addressed \| wont_fix` — set by whichever agent (design or backend) owns the item's category. |
| `rounds[].decided_status` | `changes_requested \| approved \| null` — the human/orchestrator's verdict on the round as a whole, once all items are triaged. |

**Cap**: 3 rounds. Exceeding it routes the pipeline to `blocked_needs_human`.

## 5. `qa-report.json` — QA agent's structured audit

Schema: `schemas/qa-report.schema.json`

**Write ownership**: the QA agent is the **only** writer of this file — it creates rounds, findings, `acceptance_criteria_check`, and `round_result`. The one carve-out: design/backend agents may update `status`/`agent_note` on findings assigned to them via `category`, and only to `fixed_claimed` or `disputed` — never `wont_fix`, `verified_fixed`, or `superseded`, which are QA-exclusive. This asymmetry is deliberate: no agent can dismiss or confirm-fix its own finding.

Read by: design, backend, integration lead.

| Field | Meaning |
|---|---|
| `overall_status` | `pass \| fail` — computed from `pass_condition` (see below), **not** a field an agent sets freely. |
| `current_round` | Authoritative round counter — `pipeline-status.json.qa_revision_round` is a copy of this. |
| `rounds[].scope` | Always `"full"` — every round re-checks the entire site to catch regressions, never an incremental re-check of only what changed. |
| `rounds[].findings[].severity` | `blocker \| major \| minor`. |
| `rounds[].findings[].status` | Lifecycle: starts `open` → agent sets `fixed_claimed`/`disputed` → QA (next round) sets exactly one of `verified_fixed`, `wont_fix`, or opens a new finding with `reopened_from_id` pointing back (and marks the original `superseded` in that same action). `superseded` findings are permanently excluded from the unresolved check — only the live chain-tip counts. |
| `rounds[].findings[].reopened_from_id` | Links a reopened finding back to the original it superseded — forms a chain across rounds for the same underlying issue. |
| `rounds[].findings[].screenshot_ref` | Nullable (QA can flag non-visual issues, e.g. console errors, with nothing to screenshot). When set, must be a path relative to this repo's root — `clients/<client_id>/.pipeline/qa/screenshots/round-{n}/<name>.png` — never a bare filename; Playwright MCP's screenshot tool resolves a bare filename against its own process cwd (this repo's root) and drops it there directly, which is unresolvable to anyone reading the report back later. |
| `rounds[].acceptance_criteria_check[]` | Fresh, full re-verification of every `kickoff.json.acceptance_criteria` entry, every round — no cross-round linking (unlike findings, an old failure here doesn't carry forward as a record; it's just re-checked). |
| `rounds[].round_result` | `pass \| fail` — **descriptive/audit only**, not load-bearing for `overall_status`. Recorded so you can see what a round's snapshot looked like at the time, but the actual pass/fail decision always comes from a live re-check of `pass_condition`, never from this stored field. |

**Round closing**: a round closes once every finding has an agent response (`fixed_claimed`/`disputed`) or the round cap (2) is hit — whichever comes first — triggering the next QA round.

**`pass_condition`** (two deliberately different scopes — do not conflate them):
- **Findings** — scoped across **every finding in every round to date**, excluding `superseded`: fails if any finding with `severity: blocker` is in status `{open, disputed, fixed_claimed}`. (`fixed_claimed` counts as unresolved here — an agent's unverified claim is not QA confirmation.)
- **Acceptance criteria** — scoped to the **current round's** `acceptance_criteria_check[]` only: passes only if every entry has `verified == true`.

```
overall_status = "pass" when pass_condition is true (both scopes satisfied)
otherwise:
  - if the round cap is NOT yet hit: stay in "qa_revision" (another round runs)
  - if the round cap IS hit: → blocked_needs_human
```

Cap-hit is not separate logic from the above — it's the exact same `pass_condition` check, evaluated with zero rounds remaining.

**Not schema-enforced**: the `overall_status`/`round_result` computation above is cross-record business logic, not a static shape constraint — `schemas/qa-report.schema.json` validates that each field has the right *type*, not that `overall_status` was computed correctly from the findings/criteria present. Enforcing that is the orchestrator's job (or a lint/CI check written against the schema's output), not the JSON Schema's.

## 6. `signoff.json` — integration lead's final gate

Schema: `schemas/signoff.schema.json`

**Write ownership**:
- **Integration lead agent**: writes `checklist` and each `unresolved_majors[].decision`/`decision_note`. Never writes `client_final_approval`.
- **Client-approval intake** (human/orchestrator): the only writer of `client_final_approval.status`/`approved_at`/`approved_by`/`notes`/`requested_changes`.

Not read by any other pipeline file/agent (terminal file) — read by humans/dashboards only.

| Field | Meaning |
|---|---|
| `review_rounds[].checklist` | `{repo_pushed, preview_deploy_live, dns_domain_configured (bool \| "n/a"), env_vars_configured}` — mechanical pre-launch checks, not QA findings. |
| `review_rounds[].unresolved_majors[]` | Major-severity (not blocker — those can't reach signoff at all per `qa-report.json`'s `pass_condition`) QA findings still open at signoff time. Each gets an explicit `decision`: `ship_anyway` or `kick_back_to_qa`. |
| `review_rounds[].client_final_approval` | The **second** human checkpoint, distinct from early mockup approval — the client's review of the complete, QA-passed site right before it goes live. |
| `review_rounds[].client_final_approval.requested_changes[]` | Raw, unauthored client input only — **never** a `qa-report.json` finding directly. Authorship of findings stays QA's exclusive right; when routing back to `qa_revision`, the QA agent is invoked with `requested_changes` as context and authors the resulting findings itself in its next round. |
| `review_rounds[].round_outcome` | `promoted \| returned_to_qa \| pending` — the resolved outcome of this review round. |
| `repo_url` / `preview_deploy_url` / `production_url` | Where the client's actual deployed code lives, at each stage of promotion. |
| `production_promotion_status` | `not_promoted \| promoted` — has the preview deploy actually been promoted to the live production URL yet. |

Deliberately **not** duplicated here: `qa_passed`/`acceptance_criteria_verified` fields. The integration lead reads `qa-report.json.overall_status` and its current round's `acceptance_criteria_check` directly at review time instead — avoiding a second copy of state that could drift from the source of truth.

**Round closing**:
- → **`promoted`**: all `checklist` items `true`/`n/a` AND all `unresolved_majors[].decision == ship_anyway` AND `client_final_approval.status == approved`.
- → **`returned_to_qa`**: any `unresolved_majors[].decision == kick_back_to_qa`, OR `client_final_approval.status == changes_requested`. Both consume a round from QA's *existing* cap (there is no separate signoff-specific cap); if that cap is already exhausted, this routes to `blocked_needs_human` instead.

## Agent Read/Write Matrix (summary)

| File | Written by | Read by |
|---|---|---|
| `kickoff.json` | human/intake (once) | all agents |
| `scraper-output.json` | scraper agent (once) | design, backend, QA |
| `design-lock.json` | design agent (write once + append during remaining_pages) | design, backend, QA, integration lead |
| `mockup-approval.json` | intake (rounds/decisions), design (status on visual/content), backend (status on deferred functional/integration) | design, backend, integration lead |
| `qa-report.json` | QA agent (exclusive) except `status → fixed_claimed/disputed` by design/backend on assigned findings | design, backend, integration lead |
| `signoff.json` | integration lead (checklist/decisions), client intake (`client_final_approval`) | — |
| `pipeline-status.json` | orchestrator (stage transitions, round mirrors) | all agents (first read on invocation) |

## Concurrency model

Strictly sequential — only one agent is active per client at a time. No file-locking is designed for because there's no concurrent-write race to prevent. This is a deliberate, revisitable tradeoff (it gives up the wall-clock savings of running design and backend in parallel for simplicity), not an oversight.

This does **not** relax the write-ownership rules above — those exist to preserve audit integrity (QA is the exclusive author of its findings' terminal statuses, clients can't author findings directly, agents can't self-dismiss their own QA findings), independent of whether a collision is physically possible. When agents are built, these boundaries must be enforced via actual scoped tool/file permissions per agent — not left as documentation an agent could choose to ignore.

## Out of scope

- The multi-tenant orchestration layer itself (how agents get invoked, queued, scheduled) — this document only covers the state files they share.
- Concurrency/locking — ruled out by the strictly-sequential model above.
- Schema migration tooling for `schema_version` bumps — a future concern, not covered here.
