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
| `chaiverse` | `clients/chaiverse/kickoff-chaiverse.json` (see 1.8 — no `scraper-output.json` exists yet) | `"geelong"`, `"werribee"` |

For the two single-location clients this is a pure reshape: existing flat `address`/`phone`/`hours` under `business_info` become a one-entry `locations[]` array; existing flat `reviews.aggregate_rating`/`review_count`/`places_place_id`/`live_display` become a one-entry `reviews.by_location[]` array. No data is invented or dropped. Both files' `schema_version` fields get bumped to `"2.0"` as part of the same edit.

`cafe-and-pizzaro-richmond`'s kickoff.json also gets its `primary_contact.email` placeholder string replaced with `null` (honest "unknown," now schema-valid, per 1.3) — not left as a lie that happens to parse as a string.

### 1.8 Chaiverse — not yet fully onboarded, handled as-is

`clients/chaiverse/kickoff-chaiverse.json` exists (staged, pre-onboarding — not yet under a `.pipeline/` directory, presumably pending `onboard-client.ts`) but there is **no `scraper-output.json` for Chaiverse yet** — the scraper agent hasn't run. Its `primary_contact.email` is already `null`, which happens to already anticipate 1.3.

Scope for this task: add `location_id` (`"geelong"`, `"werribee"`) to its two `business.locations[]` entries and bump `schema_version` to `"2.0"`. File placement (moving it under `.pipeline/`) is an onboarding-process step, not a schema-migration step — out of scope here, left for whoever runs `onboard-client.ts`. No `scraper-output.json` will be created for Chaiverse in this task — fabricating scrape data would misrepresent a real client's content; that's the scraper agent's job to produce for real. It will be reported as "not yet produced" in the validation report, not pass/fail.

### 1.9 `.claude/agents/scraper-agent.md` updates

Currently documents the flat shape directly (e.g. "populate `business_info.*`... always populate `reviews.aggregate_rating`..."). Updates needed:
- Step 3 (Places API resolution): call `places-lookup.ts` once per physical location (looping over `kickoff.json`'s `business.locations[]`), matching each result's `location_id` to the corresponding kickoff location entry — not one lookup for the whole business.
- `SourcedField<T>` wrapping section: clarify which fields are business-wide vs. per-location.
- `completeness` self-assessment: extend the `good`/`partial`/`poor` thresholds to require the address/phone bar be met for **every** location, not just one — a multi-location scrape that nails Geelong but comes up empty on Werribee should not silently read as `good`.
- Reviews & Places API compliance section: same per-location loop applies to the reviews block.

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

## Validation report (deliverable, not a file)

After implementation, run every touched schema's fixtures through `bun test`, then separately validate all real client files individually and report pass/fail per client per file (not summarized):

- `cafe-and-pizzaro-richmond/.pipeline/kickoff.json`
- `cafe-and-pizzaro-richmond/.pipeline/scraper-output.json`
- `rg-detailing-geelong/.pipeline/kickoff.json`
- `rg-detailing-geelong/.pipeline/scraper-output.json`
- `clients/chaiverse/kickoff-chaiverse.json`
- Chaiverse `scraper-output.json` — reported as "not yet produced," not pass/fail.

## Out of scope

- Moving Chaiverse's kickoff file under a `.pipeline/` directory (an `onboard-client.ts` / human-intake step).
- Running the scraper agent for Chaiverse for real.
- Adding `minItems: 1` to any `locations`/`by_location` array (noted as a considered-and-declined addition, not silently skipped).
- Any change to `design-lock.json`, `mockup-approval.json`, `qa-report.json`, `signoff.json`, or `pipeline-status.json` schemas — none of the multi-location changes touch them.
- Backend-agent's live Places review-fetch implementation logic — out of scope for this schema-layer change; it already reads `places_place_id` per-listing, and will need a per-location loop when backend-agent is actually built against this shape, but no backend-agent code exists yet to update.
