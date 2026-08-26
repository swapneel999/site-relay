# Multi-location schema support + kickoff validation gap — design

Source request: chat, 2026-08-26. Confirmed decisions: migrate existing clients to the new shape (not dual-shape support); update `.claude/agents/scraper-agent.md` in the same pass.

## Motivation

Chaiverse is the first client with more than one physical location (Geelong + Werribee). `scraper-output.json`'s `business_info`/`reviews` are currently flat (one address/phone/hours, one Places listing) and cannot represent this. Separately, two real clients have already hit a gap where `primary_contact.email` is unknown at kickoff time and got filled with placeholder text instead of a real value, because the schema doesn't allow `null` there and no standing validator exists to catch it before commit.

## Part 1 — Multi-location schema support

### 1.1 `common.schema.json` — new shared def

```json
"locationId": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "minLength": 1 }
```

A kebab-case slug (`"geelong"`, `"werribee"`), scoped for uniqueness within its containing file only — consistent with `docs/spec.md`'s existing `id` convention ("opaque strings unique within their containing file only, not globally unique across files").

### 1.2 `kickoff.schema.json` — `business.locations[]` gains `location_id`

Each location item becomes `{location_id, address, phone, hours}` (`location_id` required, using the new `locationId` def). This is the knock-on change: `scraper-output.json`'s new per-location arrays need something stable to key against, and today `kickoff.json`'s `locations[]` has no id at all — matching by position would silently break if the array is ever reordered, which is exactly the failure mode flagged in the original request.

No other change to `kickoff.schema.json`'s `locations` shape (no `minItems` added — matches today's behavior, not introducing a second unrelated constraint).

### 1.3 `kickoff.schema.json` — `primary_contact.email` becomes nullable

```json
"email": { "anyOf": [{ "type": "string", "format": "email" }, { "type": "null" }] }
```

Same pattern already used for `destination_email` elsewhere in this schema. This lets intake write `null` for "not known yet" instead of placeholder text that happens to satisfy `type: string` but not `format: email` — which is exactly what broke `cafe-and-pizzaro-richmond`'s kickoff.json.

### 1.4 `scraper-output.schema.json` — `business_info` split

```
business_info: {
  name: SourcedField<string>,           // business-wide, unchanged
  categories: SourcedField<string[]>,   // business-wide, unchanged
  price_level: SourcedField<string>,    // business-wide, unchanged
  locations: [
    { location_id, address: SourcedField<string>, phone: SourcedField<string>, hours: SourcedField<string> },
    ...
  ]
}
```

### 1.5 `scraper-output.schema.json` — `reviews` split

Each physical location has its own Google Business Profile (its own `place_id`, its own aggregate rating and review count — there is no such thing as one Places listing spanning two branches), so this becomes per-location too:

```
reviews: {
  by_location: [
    { location_id, aggregate_rating: SourcedField<number>, review_count: SourcedField<number>,
      places_place_id: SourcedField<string>, live_display: {mode, max_results, sort, note} },
    ...
  ],
  own_site_testimonials: [...]   // stays business-wide, unchanged
}
```

`own_site_testimonials` stays a single flat list: a testimonial pulled off the client's homepage is essentially never attributed to a specific branch, so per-location scoping here would be speculative structure with nothing real to key it on.

### 1.6 `content_found[]` — unchanged

Confirmed no concrete need for location-scoping; stays page-keyed exactly as today.

### 1.7 Migration of existing committed files (decided: migrate, not dual-shape)

Bump `schema_version` to `"2.0"` on `kickoff.schema.json` and `scraper-output.schema.json` (other schemas untouched, stay `"1.0"`). Mechanically rewrite, content-preserving:

| Client | Files touched | `location_id` assigned |
|---|---|---|
| `cafe-and-pizzaro-richmond` | `.pipeline/kickoff.json`, `.pipeline/scraper-output.json` | `"richmond"` |
| `rg-detailing-geelong` | `.pipeline/kickoff.json`, `.pipeline/scraper-output.json` | `"geelong"` |
| `chaiverse` | `clients/chaiverse/.pipeline/kickoff.json` (moved/renamed from `clients/chaiverse/kickoff-chaiverse.json` — see 1.8; no `scraper-output.json` exists yet) | `"geelong"`, `"werribee"` |

For the two single-location clients this is a pure reshape: existing flat `address`/`phone`/`hours` under `business_info` become a one-entry `locations[]` array; existing flat `reviews.aggregate_rating`/`review_count`/`places_place_id`/`live_display` become a one-entry `reviews.by_location[]` array. No data is invented or dropped. Both files' `schema_version` fields get bumped to `"2.0"` as part of the same edit.

`cafe-and-pizzaro-richmond`'s kickoff.json also gets its `primary_contact.email` placeholder string replaced with `null` (honest "unknown," now schema-valid, per 1.3) — not left as a lie that happens to parse as a string.

### 1.8 Chaiverse — wrong path, fix as part of this task; not yet scraped

`clients/chaiverse/kickoff-chaiverse.json` is at the wrong path — every other client's kickoff file lives at `clients/<client_id>/.pipeline/kickoff.json`, and nothing in this pipeline's tooling (scripts, hooks, agent definitions) looks anywhere else. This task moves/renames it to `clients/chaiverse/.pipeline/kickoff.json` (creating the `.pipeline/` directory), not just edits its contents in place. This is a path correction, not an onboarding step — `onboard-client.ts`'s job is GitHub/Vercel provisioning and `clients.json` registration, neither of which this task performs or depends on.

There is **no `scraper-output.json` for Chaiverse yet** — the scraper agent hasn't run. Its `primary_contact.email` is already `null`, which happens to already anticipate 1.3.

Scope for this task: move the file to the correct path, add `location_id` (`"geelong"`, `"werribee"`) to its two `business.locations[]` entries, and bump `schema_version` to `"2.0"`. No `scraper-output.json` will be created for Chaiverse in this task — fabricating scrape data would misrepresent a real client's content; that's the scraper agent's job to produce for real. It will be reported as "not yet produced" in the validation report, not pass/fail.

### 1.9 `.claude/agents/scraper-agent.md` updates

Currently documents the flat shape directly (e.g. "populate `business_info.*`... always populate `reviews.aggregate_rating`..."). Updates needed:
- Step 3 (Places API resolution): call `places-lookup.ts` once per physical location (looping over `kickoff.json`'s `business.locations[]`), matching each result's `location_id` to the corresponding kickoff location entry — not one lookup for the whole business.
- `SourcedField<T>` wrapping section: clarify which fields are business-wide vs. per-location.
- `completeness` self-assessment: replaced entirely by the decided rule in 1.10 below.
- Reviews & Places API compliance section: same per-location loop applies to the reviews block.

### 1.10 Completeness threshold for multi-location scrapes — decided rule

**Question:** does `good` require *every* location to independently clear the original single-location bar (address+phone resolved), or a more forgiving rule where one fully-resolved location is enough?

**Decision: strict — every location must independently clear the bar for `good`.** Reasoning:

- The three-tier system already has a tier built for exactly the "meaningfully different, but not fully solved" case the forgiving rule is trying to protect: a 2-location scrape that nails one branch and only partially resolves the other lands in `partial`, not `poor` — it is *not* collapsed into the same bucket as a scrape that fails on both locations (that still requires `business_info.name` itself to be unresolved to reach `poor` — a single location's address/phone being entirely missing was never a `poor` trigger even in the original single-location rule, and stays that way here). So the gradation the forgiving rule wants already exists; it just lives in the `partial` tier, not in a loosened `good`.
- `completeness: good` is a signal downstream stages treat as "safe to proceed without human review" (`docs/spec.md`: "Lets the orchestrator halt to `blocked_needs_human` if a scrape mostly failed"). Letting `good` pass when one physical location's address or phone is entirely unresolved means a real customer could show up at, or call, a location the site can't actually help them reach — for Chaiverse specifically, its own `acceptance_criteria` requires "Both Geelong and Werribee branches are clearly and separately represented (address, hours, map)," which a lenient rule would directly risk violating without any escalation.
- The `reviews` signal (`aggregate_rating`/`review_count`) is treated differently, deliberately: it stays an OR across all locations (matching the original single-location rule's own "at least one of" phrasing, generalized verbatim), not an AND. A newer branch legitimately having zero reviews yet is a normal, non-alarming state — the review count is a bonus/social-proof signal, not a core "can the customer reach us" fact the way address/phone are. This is the deliberate asymmetry in the design: core identity facts (name, and address/phone per location) get the strict bar; social-proof signals don't.

**The rule, stated exactly** (generalizes the original prose 1:1 — for a single-location client, "every location" and "any location" both collapse to checking that one location, which is provably identical to the original wording):

- **`poor`** if `business_info.name` is `not_found` (`confidence: "missing"`), OR `name.source == "web_search"` with `confidence == "inferred"` (a low-confidence identity guess, the fallback-to-web-search-for-identity case).
- **`partial`** (checked only if not `poor`) if **any** location has `address.confidence == "missing"` OR `phone.confidence == "missing"` (either alone triggers — matches the original "either one alone triggers this" wording exactly), OR that location has 2-or-more of `{address, phone, hours}` at `confidence: "missing"` (kept for the same belt-and-suspenders reason the original comment gives — with only 3 fields, this is logically subsumed by the first clause, but is kept so the two thresholds can never disagree), OR `content_found` has zero items with a non-empty `text_blocks`, OR the reviews signal is empty everywhere (no location's `aggregate_rating.confidence != "missing"`, AND `own_site_testimonials` is empty).
- **`good`** otherwise: **every** location has `address` and `phone` both resolved (`confidence != "missing"` — `hours` still exempted, exactly as in the original "not hours" carve-out), **and** at least one `content_found[]` item has a text block, **and** at least one of `{any location's aggregate_rating present, own_site_testimonials non-empty}`.

**Verification, not assumption — a real pure function with tests:** the exact-reduction requirement ("single-location clients must produce byte-identical results to the pre-existing logic") isn't provable by reading prose side-by-side; it needs a real executable check. Adding:
- `lib/scraper-completeness.ts` — a small pure function, `assessCompleteness(data): "good" | "partial" | "poor"`, taking the exact shape of `scraper-output.json`'s `data.business_info`/`data.content_found`/`data.reviews` (post-migration, multi-location shape) and implementing the rule above. Not wired into the agent's `Bash` allowlist or called at runtime by any agent — its only job is to make the threshold rule executable and testable rather than prose the agent has to interpret by eye each run. (First file under a new top-level `lib/`; every existing `scripts/*.ts` is a Bash-invoked CLI wrapper, which this deliberately isn't.)
- `tests/lib/scraper-completeness.test.ts` — including the specific case the exact-reduction requirement demands: a fixture with exactly one location, built to be `good` under the pre-existing single-location prose rule (address/phone verified, hours missing — proving the "not hours" carve-out still holds), asserted to still produce `good` under the new function. Plus multi-location cases covering the tiers this decision is actually about: both locations fully resolved → `good`; one fully resolved + one missing only `phone` → `partial` (the "meaningfully different from failing both" case, landing correctly); one fully resolved + one entirely `not_found` on all three fields → `partial`, not `poor` (proving total per-location failure still doesn't escalate past `partial` as long as `name` is known); `name` unresolved → `poor`; reviews empty everywhere with everything else resolved → `partial`.

`.claude/agents/scraper-agent.md`'s completeness section is rewritten to state this exact rule (not a summary of it), so the prose and the tested function agree by construction.

## Part 2 — Kickoff validation gap

### 2.1 `scripts/validate-kickoff.ts` — new standalone CLI

Human-triggered, no hook, no agent frontmatter — same category as `onboard-client.ts`. Compiles `kickoff.schema.json` with ajv the same way `tests/schemas/helpers.ts` does (inlined, since `scripts/` doesn't import from `tests/`), validates a given file, and reports pass/fail:

```
bun scripts/validate-kickoff.ts <path-to-kickoff.json>
```

- Valid → `{"status":"valid","path":...}`, exit 0.
- Invalid → `{"status":"invalid","path":...,"errors":[...ajv's full error list...]}`, exit 1.

No dedicated test file — matches `onboard-client.ts`'s precedent (no `tests/*.test.ts` exists for it either), and this script's entire job is "run ajv and report," which is exactly what `tests/schemas/kickoff.test.ts` already exercises against the schema itself.

## Fixture and test updates

- `tests/schemas/fixtures/kickoff/valid.json` — add `location_id: "main"` to its one location entry, keep everything else.
- New fixture `tests/schemas/fixtures/kickoff/valid-null-email.json` (or extend `kickoff.test.ts` with an inline case) — proves `primary_contact.email: null` now validates.
- `tests/schemas/fixtures/kickoff/invalid-ai-generated-real-subject.json` — add `location_id` to its (empty-locations-array) fixture only if needed to keep it schema-shape-consistent; it's `locations: []` so no per-item change needed.
- `tests/schemas/fixtures/scraper-output/valid.json` — rewrite `business_info`/`reviews` into the new split/array shape.
- `tests/schemas/fixtures/scraper-output/invalid-missing-confidence.json` — rewrite into the new shape too, keeping its one deliberately-invalid field (missing `confidence`) so the test still exercises the same failure mode.
- `tests/schemas/full-pipeline.test.ts` — no structural change needed (it just validates each `valid.json` against its own schema and checks `client_id` consistency); will pass once the two fixtures above are updated.
- `tests/schemas/kickoff.test.ts` / `tests/schemas/scraper-output.test.ts` — add the new nullable-email and per-location test cases.
- `tests/lib/scraper-completeness.test.ts` (new) — the exact-reduction case plus the multi-location tier cases described in 1.10.

## Validation report (deliverable, not a file)

After implementation, run every touched schema's fixtures through `bun test`, then separately validate all real client files individually and report pass/fail per client per file (not summarized):

- `cafe-and-pizzaro-richmond/.pipeline/kickoff.json`
- `cafe-and-pizzaro-richmond/.pipeline/scraper-output.json`
- `rg-detailing-geelong/.pipeline/kickoff.json`
- `rg-detailing-geelong/.pipeline/scraper-output.json`
- `clients/chaiverse/.pipeline/kickoff.json` (post-move)
- Chaiverse `scraper-output.json` — reported as "not yet produced," not pass/fail.

## Out of scope

- Running the scraper agent for Chaiverse for real.
- Adding `minItems: 1` to any `locations`/`by_location` array (noted as a considered-and-declined addition, not silently skipped).
- Any change to `design-lock.json`, `mockup-approval.json`, `qa-report.json`, `signoff.json`, or `pipeline-status.json` schemas — none of the multi-location changes touch them.
- Backend-agent's live Places review-fetch implementation logic — out of scope for this schema-layer change; it already reads `places_place_id` per-listing, and will need a per-location loop when backend-agent is actually built against this shape, but no backend-agent code exists yet to update.
