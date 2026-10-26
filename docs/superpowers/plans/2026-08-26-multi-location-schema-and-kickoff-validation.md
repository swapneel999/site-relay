# Multi-location Schema Support + Kickoff Validation Gap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-location support to `scraper-output.json`/`kickoff.json` (keyed by a new `location_id`), migrate the two existing single-location clients plus Chaiverse to the new shape, fix the `primary_contact.email` nullability gap, and build the standing `validate-kickoff.ts` CLI that was agreed on but never built.

**Architecture:** Two draft-07 JSON Schemas (`kickoff.schema.json`, `scraper-output.schema.json`) bump to `schema_version: "2.0"` for a breaking, non-conditional shape change — no dual-shape support, per the decided migration strategy. A new shared `locationId` def in `common.schema.json` is the correlation key between the two files. A new pure function (`lib/scraper-completeness.ts`, already implemented in a prior session) encodes the multi-location completeness threshold rule. Three real clients' committed `.pipeline/` files get mechanically migrated to the new shape, content-preserving.

**Tech Stack:** TypeScript on Bun, `ajv`/`ajv-formats` for schema compilation and validation, `bun:test` for the test runner. No build/lint step (`tsconfig.json` is `noEmit: true`, used only for editor type-checking).

**Spec:** `docs/superpowers/specs/2026-08-26-multi-location-schema-and-kickoff-validation-design.md`

## Global Constraints

- Schemas are draft-07, compiled with `ajv({ strict: true, allErrors: true })` + `ajv-formats`, sharing `$defs` via `schemas/common.schema.json` (see `tests/schemas/helpers.ts`'s `compileSchema()` for the exact pattern).
- Every schema has a matching valid/invalid fixture pair under `tests/schemas/fixtures/<name>/`.
- `tests/schemas/full-pipeline.test.ts` requires every schema's `valid.json` fixture to share `client_id: "acme-co"` — do not break this.
- `schema_version` bumps to `"2.0"` on `kickoff.schema.json` and `scraper-output.schema.json` only. Every other schema (`common`, `design-lock`, `mockup-approval`, `qa-report`, `signoff`, `pipeline-status`) stays `"1.0"` — do not touch their version or shape.
- `location_id` format is the new `common.schema.json#/$defs/locationId`: `^[a-z0-9]+(-[a-z0-9]+)*$`, `minLength: 1` (kebab-case slug). It is opaque and unique only within its containing file, never globally (matches `docs/spec.md`'s existing `id` convention).
- Do **not** add `minItems: 1` to any `locations`/`by_location` array — considered and explicitly declined in the design doc (matches today's behavior, avoids an unrelated new constraint).
- Real per-client pipeline files live at `clients/<client_id>/.pipeline/<file>.json`. The whole `clients/` directory is gitignored in this repo (`.gitignore` line 3) — these are live per-client site scaffolds, not tracked here, so file edits under `clients/` never need `git add`.
- Migration of existing client files must be content-preserving: reshape only, never invent or drop a value.
- Run `bun test` after every task; it must stay green (196+ pass, 0 fail, only the two pre-existing self-skipping dry-run tests skipped) before moving to the next task.

---

### Task 1: `common.schema.json` — add the shared `locationId` def

**Files:**
- Modify: `schemas/common.schema.json`
- Modify: `tests/schemas/common.test.ts`

**Interfaces:**
- Produces: `common.schema.json#/$defs/locationId` — a kebab-slug string def, consumed by Task 2 (`kickoff.schema.json`) and Task 3 (`scraper-output.schema.json`).

- [ ] **Step 1: Write the failing tests**

Edit `tests/schemas/common.test.ts` — add `"locationId"` to the existing `$defs` presence list, and add a new test:

```ts
describe("common.schema.json", () => {
  test("compiles standalone and exposes expected $defs", () => {
    const ajv = new Ajv({ strict: true });
    addFormats(ajv);
    const common = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "common.schema.json"), "utf-8")
    );
    ajv.addSchema(common, "common.schema.json");

    for (const defName of [
      "timestamp", "url", "hexColor", "opaqueId", "locationId",
      "category", "severity",
      "sourcedFieldString", "sourcedFieldNumber", "sourcedFieldStringArray",
    ]) {
      const validate = ajv.getSchema(`common.schema.json#/$defs/${defName}`);
      expect(validate, `missing $def: ${defName}`).toBeDefined();
    }
  });

  test("sourcedFieldString accepts a verified string value and rejects a bad enum", () => {
    const ajv = new Ajv({ strict: true });
    addFormats(ajv);
    const common = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "common.schema.json"), "utf-8")
    );
    ajv.addSchema(common, "common.schema.json");
    const validate = ajv.getSchema("common.schema.json#/$defs/sourcedFieldString")!;

    expect(validate({ value: "Joe's Pizza", source: "own_site", confidence: "verified" })).toBe(true);
    expect(validate({ value: null, source: "not_found", confidence: "missing" })).toBe(true);
    expect(validate({ value: "x", source: "made_up_source", confidence: "verified" })).toBe(false);
  });

  test("locationId accepts a kebab-case slug and rejects invalid forms", () => {
    const ajv = new Ajv({ strict: true });
    addFormats(ajv);
    const common = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "common.schema.json"), "utf-8")
    );
    ajv.addSchema(common, "common.schema.json");
    const validate = ajv.getSchema("common.schema.json#/$defs/locationId")!;

    expect(validate("geelong")).toBe(true);
    expect(validate("cafe-and-pizzaro-richmond")).toBe(true);
    expect(validate("")).toBe(false);
    expect(validate("Geelong")).toBe(false);
    expect(validate("geelong_west")).toBe(false);
    expect(validate("-geelong")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/schemas/common.test.ts`
Expected: FAIL — `missing $def: locationId` and the new `locationId` test errors with "ajv.getSchema(...) is undefined" (calling `.test()`/`validate(...)` on `undefined`).

- [ ] **Step 3: Add the `locationId` def**

Edit `schemas/common.schema.json` — insert `locationId` right after `opaqueId`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "common.schema.json",
  "$defs": {
    "timestamp": { "type": "string", "format": "date-time" },
    "url": { "type": "string", "format": "uri" },
    "hexColor": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
    "opaqueId": { "type": "string", "minLength": 1 },
    "locationId": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$", "minLength": 1 },
    "category": { "enum": ["visual", "content", "functional", "integration"] },
    "severity": { "enum": ["blocker", "major", "minor"] },
    "sourcedFieldSource": { "enum": ["own_site", "places_api", "web_search", "not_found"] },
    "sourcedFieldConfidence": { "enum": ["verified", "inferred", "missing"] },
    "sourcedFieldString": {
      "type": "object",
      "required": ["value", "source", "confidence"],
      "additionalProperties": false,
      "properties": {
        "value": { "type": ["string", "null"] },
        "source": { "$ref": "#/$defs/sourcedFieldSource" },
        "confidence": { "$ref": "#/$defs/sourcedFieldConfidence" }
      }
    },
    "sourcedFieldNumber": {
      "type": "object",
      "required": ["value", "source", "confidence"],
      "additionalProperties": false,
      "properties": {
        "value": { "type": ["number", "null"] },
        "source": { "$ref": "#/$defs/sourcedFieldSource" },
        "confidence": { "$ref": "#/$defs/sourcedFieldConfidence" }
      }
    },
    "sourcedFieldStringArray": {
      "type": "object",
      "required": ["value", "source", "confidence"],
      "additionalProperties": false,
      "properties": {
        "value": { "type": ["array", "null"], "items": { "type": "string" } },
        "source": { "$ref": "#/$defs/sourcedFieldSource" },
        "confidence": { "$ref": "#/$defs/sourcedFieldConfidence" }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/schemas/common.test.ts`
Expected: PASS — 3 tests, 0 fail.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS, same counts as before this task (no other file references `locationId` yet, so nothing else should change).

- [ ] **Step 6: Commit**

```bash
git add schemas/common.schema.json tests/schemas/common.test.ts
git commit -m "Add shared locationId def to common.schema.json"
```

---

### Task 2: `kickoff.schema.json` — `location_id` + nullable `primary_contact.email`

**Files:**
- Modify: `schemas/kickoff.schema.json`
- Modify: `tests/schemas/fixtures/kickoff/valid.json`
- Create: `tests/schemas/fixtures/kickoff/valid-null-email.json`
- Modify: `tests/schemas/kickoff.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/locationId` (Task 1).
- Produces: `kickoff.schema.json`'s `data.business.locations[]` items now require `location_id` — consumed by Task 7/8/9 (real client migrations) and by `scraper-output.schema.json`'s design intent (Task 3) as the correlation key.

- [ ] **Step 1: Write the failing tests**

Edit `tests/schemas/fixtures/kickoff/valid.json` — add `location_id` to the one location entry:

```json
{
  "schema_version": "2.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-01T09:00:00Z",
  "last_updated_by": "human/intake",
  "data": {
    "primary_contact": { "name": "Jane Doe", "email": "jane@acme.co", "role": "Owner" },
    "languages": ["en"],
    "business": {
      "name": "Acme Co", "legal_name": "Acme Co LLC", "industry": "Home Services",
      "description": "Residential plumbing in the Denver metro area.", "founded_year": 2012,
      "existing_website_url": "https://acmeplumbing.example.com",
      "social_profiles": ["https://facebook.com/acmeplumbing"],
      "google_business_profile_url": "https://maps.google.com/?cid=12345",
      "locations": [{ "location_id": "main", "address": "123 Main St, Denver, CO", "phone": "+1-303-555-0100", "hours": "Mon-Fri 8am-6pm" }]
    },
    "goals": { "primary_conversion_goal": "phone call booking", "secondary_goals": ["email signup"] },
    "content_inventory": [
      {
        "page": "home", "sections": ["hero", "services", "testimonials"],
        "text_source": "scraper_sourced", "media_source": "client_provides",
        "represents_real_subject": true, "notes": null
      },
      {
        "page": "home", "sections": ["hero-background"],
        "text_source": "needs_writing", "media_source": "ai_generated",
        "represents_real_subject": false, "notes": "abstract decorative background"
      }
    ],
    "design_direction": {
      "style_words": ["clean", "trustworthy"], "avoid": ["neon", "clip art"],
      "reference_sites": ["https://example-competitor.com"],
      "brand_assets": { "logo_url": "https://acme.co/logo.png", "existing_colors": ["#1A73E8"], "existing_fonts": ["Inter"] }
    },
    "functional_requirements": {
      "forms": [{ "name": "Contact", "fields": ["name", "email", "message"], "destination_email": "leads@acme.co" }],
      "payments": { "required": false, "provider": null },
      "cms": { "required": false, "type": null },
      "scheduling": { "required": true, "provider": "Calendly" },
      "live_chat": { "required": false, "provider": null },
      "newsletter": { "required": false, "provider": null },
      "integrations": []
    },
    "constraints": {
      "domain": "acmeplumbing.com", "timeline_deadline": "2026-09-01",
      "budget_tier": "standard",
      "compliance": { "accessibility_level": "AA", "privacy_regime": "CCPA" }
    },
    "acceptance_criteria": [
      { "criterion": "Contact form delivers to leads@acme.co", "verification_method": "submit test form, confirm email receipt" }
    ]
  }
}
```

Create `tests/schemas/fixtures/kickoff/valid-null-email.json` — identical, but `primary_contact.email: null` and `schema_version: "2.0"`:

```json
{
  "schema_version": "2.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-01T09:00:00Z",
  "last_updated_by": "human/intake",
  "data": {
    "primary_contact": { "name": "Jane Doe", "email": null, "role": "Owner" },
    "languages": ["en"],
    "business": {
      "name": "Acme Co", "legal_name": "Acme Co LLC", "industry": "Home Services",
      "description": "Residential plumbing in the Denver metro area.", "founded_year": 2012,
      "existing_website_url": "https://acmeplumbing.example.com",
      "social_profiles": ["https://facebook.com/acmeplumbing"],
      "google_business_profile_url": "https://maps.google.com/?cid=12345",
      "locations": [{ "location_id": "main", "address": "123 Main St, Denver, CO", "phone": "+1-303-555-0100", "hours": "Mon-Fri 8am-6pm" }]
    },
    "goals": { "primary_conversion_goal": "phone call booking", "secondary_goals": ["email signup"] },
    "content_inventory": [
      {
        "page": "home", "sections": ["hero", "services", "testimonials"],
        "text_source": "scraper_sourced", "media_source": "client_provides",
        "represents_real_subject": true, "notes": null
      }
    ],
    "design_direction": {
      "style_words": ["clean", "trustworthy"], "avoid": ["neon", "clip art"],
      "reference_sites": [],
      "brand_assets": { "logo_url": null, "existing_colors": [], "existing_fonts": [] }
    },
    "functional_requirements": {
      "forms": [{ "name": "Contact", "fields": ["name", "email", "message"], "destination_email": null }],
      "payments": { "required": false, "provider": null },
      "cms": { "required": false, "type": null },
      "scheduling": { "required": false, "provider": null },
      "live_chat": { "required": false, "provider": null },
      "newsletter": { "required": false, "provider": null },
      "integrations": []
    },
    "constraints": {
      "domain": null, "timeline_deadline": null,
      "budget_tier": "starter",
      "compliance": { "accessibility_level": "none", "privacy_regime": "none" }
    },
    "acceptance_criteria": []
  }
}
```

Edit `tests/schemas/kickoff.test.ts` — add the null-email test:

```ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("kickoff.schema.json", () => {
  const validate = () => compileSchema("kickoff.schema.json");

  test("accepts a valid kickoff.json", () => {
    const v = validate();
    expect(v(loadFixture("kickoff", "valid"))).toBe(true);
  });

  test("rejects media_source: ai_generated paired with represents_real_subject: true", () => {
    const v = validate();
    expect(v(loadFixture("kickoff", "invalid-ai-generated-real-subject"))).toBe(false);
  });

  test("accepts primary_contact.email: null (unknown at kickoff time)", () => {
    const v = validate();
    expect(v(loadFixture("kickoff", "valid-null-email"))).toBe(true);
  });

  test("rejects a business.locations[] entry missing location_id", () => {
    const v = validate();
    const fixture = loadFixture("kickoff", "valid") as any;
    const broken = JSON.parse(JSON.stringify(fixture));
    delete broken.data.business.locations[0].location_id;
    expect(v(broken)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/schemas/kickoff.test.ts`
Expected: FAIL on all 4 tests — `location_id` isn't a recognized property yet (schema still has `additionalProperties: false` without `location_id`, so fixtures with it now fail as unexpected-property; email is still non-nullable so the null-email fixture fails; the "rejects missing location_id" test fails because there's no such requirement yet, so deleting it changes nothing and the fixture still validates as `true`, not `false`).

- [ ] **Step 3: Implement the schema changes**

Edit `schemas/kickoff.schema.json` — bump `schema_version` intent to `"2.0"` (the field itself is just `{"type":"string"}`, no change needed there), change `primary_contact.email`, and add `location_id` to `business.locations[]`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "kickoff.schema.json",
  "title": "kickoff.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "client_id", "last_updated_at", "last_updated_by", "data"],
  "properties": {
    "schema_version": { "type": "string" },
    "client_id": { "type": "string" },
    "last_updated_at": { "$ref": "common.schema.json#/$defs/timestamp" },
    "last_updated_by": { "type": "string" },
    "data": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "primary_contact", "languages", "business", "goals", "content_inventory",
        "design_direction", "functional_requirements", "constraints", "acceptance_criteria"
      ],
      "properties": {
        "primary_contact": {
          "type": "object", "additionalProperties": false,
          "required": ["name", "email", "role"],
          "properties": {
            "name": { "type": "string" },
            "email": { "anyOf": [{ "type": "string", "format": "email" }, { "type": "null" }] },
            "role": { "type": "string" }
          }
        },
        "languages": { "type": "array", "minItems": 1, "items": { "type": "string" } },
        "business": {
          "type": "object", "additionalProperties": false,
          "required": [
            "name", "legal_name", "industry", "description", "founded_year",
            "existing_website_url", "social_profiles", "google_business_profile_url", "locations"
          ],
          "properties": {
            "name": { "type": "string" },
            "legal_name": { "type": ["string", "null"] },
            "industry": { "type": "string" },
            "description": { "type": "string" },
            "founded_year": { "type": ["integer", "null"] },
            "existing_website_url": { "anyOf": [{ "$ref": "common.schema.json#/$defs/url" }, { "type": "null" }] },
            "social_profiles": { "type": "array", "items": { "$ref": "common.schema.json#/$defs/url" } },
            "google_business_profile_url": { "anyOf": [{ "$ref": "common.schema.json#/$defs/url" }, { "type": "null" }] },
            "locations": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "required": ["location_id", "address", "phone", "hours"],
                "properties": {
                  "location_id": { "$ref": "common.schema.json#/$defs/locationId" },
                  "address": { "type": "string" }, "phone": { "type": "string" }, "hours": { "type": "string" }
                }
              }
            }
          }
        },
        "goals": {
          "type": "object", "additionalProperties": false,
          "required": ["primary_conversion_goal", "secondary_goals"],
          "properties": {
            "primary_conversion_goal": { "type": "string" },
            "secondary_goals": { "type": "array", "items": { "type": "string" } }
          }
        },
        "content_inventory": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["page", "sections", "text_source", "media_source", "represents_real_subject", "notes"],
            "properties": {
              "page": { "type": "string" },
              "sections": { "type": "array", "items": { "type": "string" } },
              "text_source": { "enum": ["client_provides", "needs_writing", "scraper_sourced"] },
              "media_source": { "enum": ["client_provides", "needs_sourcing", "scraper_sourced", "ai_generated"] },
              "represents_real_subject": { "type": "boolean" },
              "notes": { "type": ["string", "null"] }
            },
            "not": {
              "properties": {
                "media_source": { "const": "ai_generated" },
                "represents_real_subject": { "const": true }
              },
              "required": ["media_source", "represents_real_subject"]
            }
          }
        },
        "design_direction": {
          "type": "object", "additionalProperties": false,
          "required": ["style_words", "avoid", "reference_sites", "brand_assets"],
          "properties": {
            "style_words": { "type": "array", "items": { "type": "string" } },
            "avoid": { "type": "array", "items": { "type": "string" } },
            "reference_sites": { "type": "array", "items": { "$ref": "common.schema.json#/$defs/url" } },
            "brand_assets": {
              "type": "object", "additionalProperties": false,
              "required": ["logo_url", "existing_colors", "existing_fonts"],
              "properties": {
                "logo_url": { "anyOf": [{ "$ref": "common.schema.json#/$defs/url" }, { "type": "null" }] },
                "existing_colors": { "type": "array", "items": { "$ref": "common.schema.json#/$defs/hexColor" } },
                "existing_fonts": { "type": "array", "items": { "type": "string" } }
              }
            }
          }
        },
        "functional_requirements": {
          "type": "object", "additionalProperties": false,
          "required": ["forms", "payments", "cms", "scheduling", "live_chat", "newsletter", "integrations"],
          "properties": {
            "forms": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "required": ["name", "fields", "destination_email"],
                "properties": {
                  "name": { "type": "string" },
                  "fields": { "type": "array", "items": { "type": "string" } },
                  "destination_email": { "anyOf": [{ "type": "string", "format": "email" }, { "type": "null" }] }
                }
              }
            },
            "payments": {
              "type": "object", "additionalProperties": false,
              "required": ["required", "provider"],
              "properties": { "required": { "type": "boolean" }, "provider": { "type": ["string", "null"] } }
            },
            "cms": {
              "type": "object", "additionalProperties": false,
              "required": ["required", "type"],
              "properties": { "required": { "type": "boolean" }, "type": { "type": ["string", "null"] } }
            },
            "scheduling": {
              "type": "object", "additionalProperties": false,
              "required": ["required", "provider"],
              "properties": { "required": { "type": "boolean" }, "provider": { "type": ["string", "null"] } }
            },
            "live_chat": {
              "type": "object", "additionalProperties": false,
              "required": ["required", "provider"],
              "properties": { "required": { "type": "boolean" }, "provider": { "type": ["string", "null"] } }
            },
            "newsletter": {
              "type": "object", "additionalProperties": false,
              "required": ["required", "provider"],
              "properties": { "required": { "type": "boolean" }, "provider": { "type": ["string", "null"] } }
            },
            "integrations": { "type": "array", "items": { "type": "string" } }
          }
        },
        "constraints": {
          "type": "object", "additionalProperties": false,
          "required": ["domain", "timeline_deadline", "budget_tier", "compliance"],
          "properties": {
            "domain": { "type": ["string", "null"] },
            "timeline_deadline": { "anyOf": [{ "type": "string", "format": "date" }, { "type": "null" }] },
            "budget_tier": { "enum": ["starter", "standard", "premium"] },
            "compliance": {
              "type": "object", "additionalProperties": false,
              "required": ["accessibility_level", "privacy_regime"],
              "properties": {
                "accessibility_level": { "enum": ["none", "AA", "AAA"] },
                "privacy_regime": { "enum": ["none", "GDPR", "CCPA", "both"] }
              }
            }
          }
        },
        "acceptance_criteria": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["criterion", "verification_method"],
            "properties": { "criterion": { "type": "string" }, "verification_method": { "type": "string" } }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/schemas/kickoff.test.ts`
Expected: PASS — 4 tests, 0 fail.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS. `tests/schemas/full-pipeline.test.ts`'s `kickoff/valid.json` check still passes (still `client_id: "acme-co"`).

- [ ] **Step 6: Commit**

```bash
git add schemas/kickoff.schema.json tests/schemas/fixtures/kickoff/valid.json tests/schemas/fixtures/kickoff/valid-null-email.json tests/schemas/kickoff.test.ts
git commit -m "kickoff.schema.json v2: location_id on business.locations[], nullable primary_contact.email"
```

---

### Task 3: `scraper-output.schema.json` — multi-location `business_info`/`reviews` split

**Files:**
- Modify: `schemas/scraper-output.schema.json`
- Modify: `tests/schemas/fixtures/scraper-output/valid.json`
- Modify: `tests/schemas/fixtures/scraper-output/invalid-missing-confidence.json`
- Create: `tests/schemas/fixtures/scraper-output/valid-multi-location.json`
- Modify: `tests/schemas/scraper-output.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/locationId` (Task 1).
- Produces: `scraper-output.schema.json`'s `data.business_info.locations[]` (each `{location_id, address, phone, hours}`) and `data.reviews.by_location[]` (each `{location_id, aggregate_rating, review_count, places_place_id, live_display}`) — consumed by Task 6 (`scraper-agent.md`) and Tasks 7/8 (real client migrations).

- [ ] **Step 1: Write the failing tests**

Edit `tests/schemas/fixtures/scraper-output/valid.json` (location_id `"main"`, matching the kickoff fixture from Task 2):

```json
{
  "schema_version": "2.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-01T10:00:00Z",
  "last_updated_by": "scraper-agent",
  "data": {
    "scrape_mode": "own_site",
    "completeness": "good",
    "business_info": {
      "name": { "value": "Acme Plumbing", "source": "own_site", "confidence": "verified" },
      "categories": { "value": ["Plumber", "Emergency Service"], "source": "own_site", "confidence": "verified" },
      "price_level": { "value": null, "source": "not_found", "confidence": "missing" },
      "locations": [
        {
          "location_id": "main",
          "address": { "value": "123 Main St, Denver, CO", "source": "own_site", "confidence": "verified" },
          "phone": { "value": "+1-303-555-0100", "source": "own_site", "confidence": "verified" },
          "hours": { "value": "Mon-Fri 8am-6pm", "source": "own_site", "confidence": "verified" }
        }
      ]
    },
    "reviews": {
      "by_location": [
        {
          "location_id": "main",
          "aggregate_rating": { "value": 4.8, "source": "places_api", "confidence": "verified" },
          "review_count": { "value": 152, "source": "places_api", "confidence": "verified" },
          "places_place_id": { "value": "ChIJabc123", "source": "places_api", "confidence": "verified" },
          "live_display": {
            "mode": "live_fetch", "max_results": 6, "sort": "highest_rated",
            "note": "Places-sourced review text/ratings/author photos must be fetched live at render/request time by the backend agent's implementation. Only place_id is persisted here."
          }
        }
      ],
      "own_site_testimonials": [
        { "author": "R. Smith", "rating": 5, "text": "Fast and professional.", "date": "2026-05-10" }
      ]
    },
    "content_found": [
      {
        "page_guess": "home", "url": "https://acmeplumbing.example.com/",
        "source": "own_site", "reuse_safe": true,
        "text_blocks": ["24/7 emergency plumbing since 2012."],
        "images": [{ "url": "https://acmeplumbing.example.com/team.jpg", "alt_text": "The Acme team", "reuse_safe": true }]
      }
    ],
    "social_profiles_found": ["https://facebook.com/acmeplumbing"],
    "scrape_notes": ["Pricing page returned 404, price_level left unset."]
  }
}
```

Edit `tests/schemas/fixtures/scraper-output/invalid-missing-confidence.json` — same new shape, keeping the one deliberate defect (`business_info.name` missing `confidence`):

```json
{
  "schema_version": "2.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-01T10:00:00Z",
  "last_updated_by": "scraper-agent",
  "data": {
    "scrape_mode": "own_site",
    "completeness": "good",
    "business_info": {
      "name": { "value": "Acme Plumbing", "source": "own_site" },
      "categories": { "value": ["Plumber"], "source": "own_site", "confidence": "verified" },
      "price_level": { "value": null, "source": "not_found", "confidence": "missing" },
      "locations": [
        {
          "location_id": "main",
          "address": { "value": "123 Main St, Denver, CO", "source": "own_site", "confidence": "verified" },
          "phone": { "value": "+1-303-555-0100", "source": "own_site", "confidence": "verified" },
          "hours": { "value": "Mon-Fri 8am-6pm", "source": "own_site", "confidence": "verified" }
        }
      ]
    },
    "reviews": {
      "by_location": [
        {
          "location_id": "main",
          "aggregate_rating": { "value": 4.8, "source": "places_api", "confidence": "verified" },
          "review_count": { "value": 152, "source": "places_api", "confidence": "verified" },
          "places_place_id": { "value": "ChIJabc123", "source": "places_api", "confidence": "verified" },
          "live_display": { "mode": "live_fetch", "max_results": 6, "sort": "highest_rated", "note": "n/a" }
        }
      ],
      "own_site_testimonials": []
    },
    "content_found": [],
    "social_profiles_found": [],
    "scrape_notes": []
  }
}
```

Create `tests/schemas/fixtures/scraper-output/valid-multi-location.json` — the real motivating case, two locations:

```json
{
  "schema_version": "2.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-08-26T10:00:00Z",
  "last_updated_by": "scraper-agent",
  "data": {
    "scrape_mode": "own_site",
    "completeness": "good",
    "business_info": {
      "name": { "value": "Acme Chai Co", "source": "own_site", "confidence": "verified" },
      "categories": { "value": ["Cafe", "Indian Street Food"], "source": "own_site", "confidence": "verified" },
      "price_level": { "value": "$$", "source": "web_search", "confidence": "inferred" },
      "locations": [
        {
          "location_id": "geelong",
          "address": { "value": "23 Cuzens Place, Geelong, VIC 3220, Australia", "source": "own_site", "confidence": "verified" },
          "phone": { "value": "+61 401 188 283", "source": "own_site", "confidence": "verified" },
          "hours": { "value": "Mon-Sun 9am-9pm", "source": "places_api", "confidence": "verified" }
        },
        {
          "location_id": "werribee",
          "address": { "value": "6/57-61 Synnot St, Werribee, VIC 3030, Australia", "source": "own_site", "confidence": "verified" },
          "phone": { "value": "+61 401 188 284", "source": "places_api", "confidence": "verified" },
          "hours": { "value": "Mon-Sun 10am-8pm", "source": "places_api", "confidence": "verified" }
        }
      ]
    },
    "reviews": {
      "by_location": [
        {
          "location_id": "geelong",
          "aggregate_rating": { "value": 4.9, "source": "places_api", "confidence": "verified" },
          "review_count": { "value": 210, "source": "places_api", "confidence": "verified" },
          "places_place_id": { "value": "ChIJgeelongExample", "source": "places_api", "confidence": "verified" },
          "live_display": { "mode": "live_fetch", "max_results": 5, "sort": "most_recent", "note": "Established branch, strong review history." }
        },
        {
          "location_id": "werribee",
          "aggregate_rating": { "value": null, "source": "not_found", "confidence": "missing" },
          "review_count": { "value": null, "source": "not_found", "confidence": "missing" },
          "places_place_id": { "value": "ChIJwerribeeExample", "source": "places_api", "confidence": "verified" },
          "live_display": { "mode": "live_fetch", "max_results": 5, "sort": "most_recent", "note": "New branch, no reviews yet — place_id resolved but no rating data returned." }
        }
      ],
      "own_site_testimonials": []
    },
    "content_found": [
      {
        "page_guess": "home", "url": "https://acmechai.example.com/",
        "source": "own_site", "reuse_safe": true,
        "text_blocks": ["Chai. Chaat. Good vibes."],
        "images": []
      }
    ],
    "social_profiles_found": [],
    "scrape_notes": ["Werribee is a newer branch with no Google reviews yet — place_id resolved, rating/count left not_found rather than guessed."]
  }
}
```

Edit `tests/schemas/scraper-output.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("scraper-output.schema.json", () => {
  const validate = () => compileSchema("scraper-output.schema.json");

  test("accepts a valid single-location scraper-output.json", () => {
    const v = validate();
    expect(v(loadFixture("scraper-output", "valid"))).toBe(true);
  });

  test("rejects a SourcedField missing 'confidence'", () => {
    const v = validate();
    expect(v(loadFixture("scraper-output", "invalid-missing-confidence"))).toBe(false);
  });

  test("accepts a valid multi-location scraper-output.json (business_info.locations[] and reviews.by_location[] each with 2 entries)", () => {
    const v = validate();
    const fixture = loadFixture("scraper-output", "valid-multi-location") as any;
    expect(fixture.data.business_info.locations.length).toBe(2);
    expect(fixture.data.reviews.by_location.length).toBe(2);
    expect(v(fixture)).toBe(true);
  });

  test("rejects a business_info.locations[] entry missing location_id", () => {
    const v = validate();
    const fixture = loadFixture("scraper-output", "valid-multi-location") as any;
    const broken = JSON.parse(JSON.stringify(fixture));
    delete broken.data.business_info.locations[0].location_id;
    expect(v(broken)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/schemas/scraper-output.test.ts`
Expected: FAIL on all 4 — the schema still expects flat `business_info.address`/`phone`/`hours` and flat `reviews.aggregate_rating` etc., so `additionalProperties: false` rejects `locations`/`by_location` and the `required` list rejects the missing flat fields.

- [ ] **Step 3: Implement the schema changes**

Replace `schemas/scraper-output.schema.json` in full:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "scraper-output.schema.json",
  "title": "scraper-output.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "client_id", "last_updated_at", "last_updated_by", "data"],
  "properties": {
    "schema_version": { "type": "string" },
    "client_id": { "type": "string" },
    "last_updated_at": { "$ref": "common.schema.json#/$defs/timestamp" },
    "last_updated_by": { "type": "string" },
    "data": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "scrape_mode", "completeness", "business_info", "reviews",
        "content_found", "social_profiles_found", "scrape_notes"
      ],
      "properties": {
        "scrape_mode": { "enum": ["own_site", "places_api", "web_search"] },
        "completeness": { "enum": ["good", "partial", "poor"] },
        "business_info": {
          "type": "object", "additionalProperties": false,
          "required": ["name", "categories", "price_level", "locations"],
          "properties": {
            "name": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
            "categories": { "$ref": "common.schema.json#/$defs/sourcedFieldStringArray" },
            "price_level": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
            "locations": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "required": ["location_id", "address", "phone", "hours"],
                "properties": {
                  "location_id": { "$ref": "common.schema.json#/$defs/locationId" },
                  "address": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
                  "phone": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
                  "hours": { "$ref": "common.schema.json#/$defs/sourcedFieldString" }
                }
              }
            }
          }
        },
        "reviews": {
          "type": "object", "additionalProperties": false,
          "required": ["by_location", "own_site_testimonials"],
          "properties": {
            "by_location": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "required": ["location_id", "aggregate_rating", "review_count", "places_place_id", "live_display"],
                "properties": {
                  "location_id": { "$ref": "common.schema.json#/$defs/locationId" },
                  "aggregate_rating": { "$ref": "common.schema.json#/$defs/sourcedFieldNumber" },
                  "review_count": { "$ref": "common.schema.json#/$defs/sourcedFieldNumber" },
                  "places_place_id": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
                  "live_display": {
                    "type": "object", "additionalProperties": false,
                    "required": ["mode", "max_results", "sort", "note"],
                    "properties": {
                      "mode": { "enum": ["live_fetch", "none"] },
                      "max_results": { "type": "integer", "minimum": 0 },
                      "sort": { "enum": ["most_recent", "highest_rated"] },
                      "note": { "type": "string" }
                    }
                  }
                }
              }
            },
            "own_site_testimonials": {
              "type": "array",
              "items": {
                "type": "object", "additionalProperties": false,
                "required": ["author", "rating", "text", "date"],
                "properties": {
                  "author": { "type": "string" },
                  "rating": { "type": ["number", "null"] },
                  "text": { "type": "string" },
                  "date": { "type": ["string", "null"] }
                }
              }
            }
          }
        },
        "content_found": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["page_guess", "url", "source", "reuse_safe", "text_blocks", "images"],
            "properties": {
              "page_guess": { "type": "string" },
              "url": { "anyOf": [{ "$ref": "common.schema.json#/$defs/url" }, { "type": "null" }] },
              "source": { "enum": ["own_site", "web_search"] },
              "reuse_safe": { "type": "boolean" },
              "text_blocks": { "type": "array", "items": { "type": "string" } },
              "images": {
                "type": "array",
                "items": {
                  "type": "object", "additionalProperties": false,
                  "required": ["url", "alt_text", "reuse_safe"],
                  "properties": {
                    "url": { "$ref": "common.schema.json#/$defs/url" },
                    "alt_text": { "type": ["string", "null"] },
                    "reuse_safe": { "type": "boolean" }
                  }
                }
              }
            }
          }
        },
        "social_profiles_found": { "type": "array", "items": { "$ref": "common.schema.json#/$defs/url" } },
        "scrape_notes": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/schemas/scraper-output.test.ts`
Expected: PASS — 4 tests, 0 fail.

- [ ] **Step 5: Run the full suite, including `full-pipeline.test.ts`**

Run: `bun test`
Expected: PASS. `full-pipeline.test.ts` validates `scraper-output/valid.json` against the new schema (passes, since it's already in the new shape) and confirms `client_id: "acme-co"` still matches across all fixtures.

- [ ] **Step 6: Commit**

```bash
git add schemas/scraper-output.schema.json tests/schemas/fixtures/scraper-output/ tests/schemas/scraper-output.test.ts
git commit -m "scraper-output.schema.json v2: split business_info/reviews into per-location arrays"
```

---

### Task 4: `docs/spec.md` — bring the field reference back in sync

**Files:**
- Modify: `docs/spec.md`

**Interfaces:**
- Consumes: the shapes finalized in Tasks 1-3 (no new interfaces produced — this is documentation only).

- [ ] **Step 1: Update the shared-envelope `schema_version` row**

In the "Shared envelope" table (`docs/spec.md` line ~14), replace:

```
| `schema_version` | Schema version this file conforms to (currently `"1.0"`). | Whoever last wrote the file. |
```

with:

```
| `schema_version` | Schema version this file conforms to. Most files are `"1.0"`; `kickoff.json` and `scraper-output.json` are `"2.0"` as of the multi-location schema change (see `docs/superpowers/specs/2026-08-26-multi-location-schema-and-kickoff-validation-design.md`) — existing single-location clients were mechanically migrated, not left on a dual-shape schema. | Whoever last wrote the file. |
```

- [ ] **Step 2: Update `kickoff.json`'s `business.locations` row**

Replace:

```
| `business.locations` | One or more physical locations; each an `{address, phone, hours}` triple. |
```

with:

```
| `business.locations` | One or more physical locations; each a `{location_id, address, phone, hours}` object. `location_id` is a kebab-slug (`common.schema.json#/$defs/locationId`), opaque and unique only within this file — it's the correlation key `scraper-output.json`'s per-location arrays match back against, chosen explicitly over positional/array-index matching so structured business facts (address, phone, live review data) stay correctly paired even if this array is ever reordered. |
```

- [ ] **Step 3: Update `scraper-output.json`'s `business_info.*`/`reviews.*` rows**

Replace:

```
| `business_info.*` | Core facts (name, address, phone, hours, categories, price level), each a `SourcedField`. |
```

with:

```
| `business_info.{name,categories,price_level}` | Business-wide core facts, each a `SourcedField` — one value regardless of how many physical locations the business has. |
| `business_info.locations[]` | Per-location facts: `{location_id, address, phone, hours}`, each of the latter three a `SourcedField`. `location_id` matches the corresponding entry in `kickoff.json`'s `business.locations[]`. |
```

Replace:

```
| `reviews.aggregate_rating` / `review_count` | Summary stats, `SourcedField<number>`. |
| `reviews.places_place_id` | The **only** Places-sourced review data persisted here. Permitted indefinitely under Places API ToS. |
| `reviews.live_display` | Instructions for the backend agent's *implementation*, not stored review content: `mode` (`live_fetch \| none`), `max_results`, `sort` (`most_recent \| highest_rated`). Review text, ratings, and author photos must be fetched live at render/request time — never baked into this file. See the compliance note below for the `PlacesReviewSample` shape the backend agent's live-fetch code should use. |
```

with:

```
| `reviews.by_location[]` | One entry per physical location: `{location_id, aggregate_rating, review_count, places_place_id, live_display}` — each physical location has its own Google Business Profile, so these are never business-wide. `aggregate_rating`/`review_count`/`places_place_id` are each `SourcedField`s; `places_place_id` is the **only** Places-sourced review data persisted here, permitted indefinitely under Places API ToS. `live_display` is instructions for the backend agent's *implementation* for that specific location, not stored review content: `mode` (`live_fetch \| none`), `max_results`, `sort` (`most_recent \| highest_rated`). Review text, ratings, and author photos must be fetched live at render/request time, per location — never baked into this file. See the compliance note below for the `PlacesReviewSample` shape the backend agent's live-fetch code should use. |
```

- [ ] **Step 4: Verify the doc still reads coherently**

Run: none (documentation-only) — read the three edited sections back and confirm no other row in the file still refers to the old flat `business_info.address`/`phone`/`hours` or singular `reviews.aggregate_rating` shape.

Run: `grep -n "business_info.address\|business_info.phone\|business_info.hours\|reviews.aggregate_rating\|reviews.places_place_id" docs/spec.md`
Expected: no matches (everything now reads `business_info.locations[]` / `reviews.by_location[]`).

- [ ] **Step 5: Commit**

```bash
git add docs/spec.md
git commit -m "Sync docs/spec.md with kickoff.json/scraper-output.json v2 multi-location shape"
```

---

### Task 5: `scripts/validate-kickoff.ts` — standing kickoff validator

**Files:**
- Create: `scripts/validate-kickoff.ts`

**Interfaces:**
- Consumes: `schemas/kickoff.schema.json` + `schemas/common.schema.json` (Tasks 1-2).
- Produces: a CLI usable standalone (`bun scripts/validate-kickoff.ts <path>`) — consumed manually in Task 9's validation report, not imported by any other file.

- [ ] **Step 1: Write the script**

Create `scripts/validate-kickoff.ts`:

```ts
#!/usr/bin/env bun
// Standing, human-triggered validator for a client's kickoff.json --
// closes the gap where cafe-and-pizzaro-richmond's kickoff.json committed
// placeholder text into primary_contact.email with nothing catching it
// before commit. No hook, no agent frontmatter -- same category as
// onboard-client.ts, run manually by whoever is finishing a client's
// kickoff.json before the pipeline starts.
//
// Usage:
//   bun scripts/validate-kickoff.ts <path-to-kickoff.json>

export {};

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function fail(message: string): never {
  console.error(JSON.stringify({ status: "error", message }));
  process.exit(1);
}

const targetPath = process.argv[2];
if (!targetPath) {
  fail("Usage: bun scripts/validate-kickoff.ts <path-to-kickoff.json>");
}

const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

const common = JSON.parse(readFileSync(join(SCHEMAS_DIR, "common.schema.json"), "utf-8"));
ajv.addSchema(common, "common.schema.json");

const kickoffSchema = JSON.parse(readFileSync(join(SCHEMAS_DIR, "kickoff.schema.json"), "utf-8"));
ajv.addSchema(kickoffSchema, "kickoff.schema.json");

const validate = ajv.getSchema("kickoff.schema.json");
if (!validate) {
  fail("ajv failed to compile kickoff.schema.json");
}

let target: unknown;
try {
  target = JSON.parse(readFileSync(targetPath, "utf-8"));
} catch (err) {
  fail(`Could not read/parse ${targetPath}: ${(err as Error).message}`);
}

const ok = validate!(target);
if (ok) {
  console.log(JSON.stringify({ status: "valid", path: targetPath }));
  process.exit(0);
} else {
  console.log(JSON.stringify({ status: "invalid", path: targetPath, errors: validate!.errors }, null, 2));
  process.exit(1);
}
```

- [ ] **Step 2: Smoke-test against the known-good fixture**

Run: `bun scripts/validate-kickoff.ts tests/schemas/fixtures/kickoff/valid.json`
Expected: exit code 0, stdout `{"status":"valid","path":"tests/schemas/fixtures/kickoff/valid.json"}`.

- [ ] **Step 3: Smoke-test against a known-bad fixture**

Run: `bun scripts/validate-kickoff.ts tests/schemas/fixtures/kickoff/invalid-ai-generated-real-subject.json`
Expected: exit code 1, stdout is a JSON object with `"status": "invalid"` and a non-empty `"errors"` array.

- [ ] **Step 4: Commit**

```bash
git add scripts/validate-kickoff.ts
git commit -m "Add scripts/validate-kickoff.ts standing CLI validator"
```

---

### Task 6: `.claude/agents/scraper-agent.md` — per-location Places lookup + SourcedField wrapping

**Files:**
- Modify: `.claude/agents/scraper-agent.md`

**Interfaces:**
- Consumes: `scraper-output.schema.json` v2 shape (Task 3) — `business_info.locations[]`, `reviews.by_location[]`.
- Produces: none (agent instruction prose only). The `completeness` section was already rewritten in a prior session to state the multi-location rule backed by `lib/scraper-completeness.ts` — this task covers the remaining sections that still described the old flat shape.

- [ ] **Step 1: Update Step 3 (Places API resolution) to loop per location**

Replace the "## Step 3: Resolving via Places API" section:

```md
## Step 3: Resolving via Places API — once per physical location

Multi-location clients have more than one entry in `kickoff.json`'s `business.locations[]`, each with its own `location_id`. Call the lookup script via `Bash` once per location — never construct the Places API request yourself, and never handle the raw API key. The script reads `GOOGLE_PLACES_API_KEY` from its own environment; you only ever pass it a search query or a place ID:

```bash
bun scripts/places-lookup.ts search --query "Chaiverse, 23 Cuzens Place, Geelong, VIC 3220, Australia"
```

This returns candidate places (id, name, address only — the search step's field mask deliberately excludes rating/review count, since including them there bumps that call into a pricier Google Places SKU tier for no benefit; those fields come from the `details` call below, which you need regardless). Pick the best match for **that specific location** (compare name/address against the corresponding `kickoff.json` `business.locations[]` entry, not any other location), then fetch full details:

```bash
bun scripts/places-lookup.ts details --place-id ChIJ...
```

Repeat search+details for every entry in `kickoff.json`'s `business.locations[]`, matching each Places result back to that location's `location_id`.

Use each location's details result to populate that location's `business_info.locations[]` entry (`address`, `phone`, `hours`) and its `reviews.by_location[]` entry (`aggregate_rating`, `review_count`, `places_place_id`) — never mix one location's Places result into another's entry. For the business-wide fields (`business_info.name`, `categories`, `price_level`), use the first location's details result if `own_site` scraping didn't already resolve them — these describe the business as a whole, not any one branch, so only one source is needed for them regardless of how many locations exist.

If the script errors for a given location (missing key, no results, HTTP failure), do not treat that as a fatal error for the whole run — log it in `scrape_notes` naming which `location_id` failed, leave that location's corresponding `SourcedField`s as `{value: null, source: "not_found", confidence: "missing"}`, and continue processing the remaining locations and whatever other sourcing is still available (falling through toward `web_search` for anything still missing).
```

- [ ] **Step 2: Update the `SourcedField<T>` wrapping section**

Replace:

```md
## `SourcedField<T>` wrapping — every leaf value, no exceptions

Every field in `business_info` and `reviews.{aggregate_rating,review_count,places_place_id}` is wrapped:
```

with:

```md
## `SourcedField<T>` wrapping — every leaf value, no exceptions

Every leaf value is wrapped, whether business-wide or per-location: `business_info.{name,categories,price_level}` (business-wide — one value regardless of location count) and, for each entry in `business_info.locations[]`, its `{address,phone,hours}`; likewise for each entry in `reviews.by_location[]`, its `{aggregate_rating,review_count,places_place_id}`:
```

(Leave the rest of that section — the `value`/`source`/`confidence` rules, the `verified`/`inferred`/`missing` definitions — unchanged; they apply identically per-field regardless of whether the field is business-wide or per-location.)

- [ ] **Step 3: Update the Places API compliance section's field references**

Replace:

```md
- `scraper-output.json` gets **only** `reviews.places_place_id`, `reviews.aggregate_rating`, `reviews.review_count`, and the `live_display` config block (`mode`, `max_results`, `sort`, `note`) — never raw review text or author photo URLs.
```

with:

```md
- `scraper-output.json` gets **only**, per location in `reviews.by_location[]`: `places_place_id`, `aggregate_rating`, `review_count`, and the `live_display` config block (`mode`, `max_results`, `sort`, `note`) — never raw review text or author photo URLs, for any location.
```

Replace:

```md
- If your Places `details` call returned a `reviews` array (individual review samples), do **not** put it in `scraper-output.json`. Instead, write up to 5 of them, verbatim as returned, to `.pipeline/scraper-cache/places-reviews-preview.json` (create the directory if needed). This file is git-ignored and regenerated every run — it exists purely so the design agent has realistic-looking testimonial content to lay out before live-fetch is wired into the real backend. It is not part of any committed schema and nothing downstream should treat it as durable.
```

with:

```md
- If a location's Places `details` call returned a `reviews` array (individual review samples), do **not** put it in `scraper-output.json`. Instead, write up to 5 of them per location, verbatim as returned, to `.pipeline/scraper-cache/places-reviews-preview.json` as `{ "by_location": [ { "location_id": "...", "samples": [...] }, ... ] }` (create the directory if needed) — keyed by `location_id` so the design agent never mixes one branch's sample reviews into another's section. This file is git-ignored and regenerated every run — it exists purely so the design agent has realistic-looking testimonial content to lay out before live-fetch is wired into the real backend. It is not part of any committed schema and nothing downstream should treat it as durable.
```

- [ ] **Step 4: Verify the file has no remaining references to the old flat shape**

Run: `grep -n "business_info\.\(address\|phone\|hours\)\b\|reviews\.\(aggregate_rating\|review_count\|places_place_id\)\b" .claude/agents/scraper-agent.md`
Expected: no matches (all such references are now qualified through `locations[]`/`by_location[]`).

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS, unchanged counts — this is a prose-only file, no test exercises it directly except the dry-run test, which self-skips (no live client in this repo).

- [ ] **Step 6: Commit**

```bash
git add .claude/agents/scraper-agent.md
git commit -m "scraper-agent.md: per-location Places lookup loop and SourcedField wrapping for multi-location shape"
```

---

### Task 7: Migrate `cafe-and-pizzaro-richmond`'s pipeline files to v2

**Files:**
- Modify: `clients/cafe-and-pizzaro-richmond/.pipeline/kickoff.json`
- Modify: `clients/cafe-and-pizzaro-richmond/.pipeline/scraper-output.json`

**Interfaces:**
- Consumes: `kickoff.schema.json` v2 (Task 2), `scraper-output.schema.json` v2 (Task 3), `scripts/validate-kickoff.ts` (Task 5).

- [ ] **Step 1: Migrate `kickoff.json`**

Replace `clients/cafe-and-pizzaro-richmond/.pipeline/kickoff.json` in full — `schema_version` to `"2.0"`, `location_id: "richmond"` added, `primary_contact.email` placeholder replaced with `null` (honest "unknown," now schema-valid):

```json
{
  "schema_version": "2.0",
  "client_id": "cafe-and-pizzaro-richmond",
  "last_updated_at": "2026-07-27T11:44:00Z",
  "last_updated_by": "human",
  "data": {
    "primary_contact": {
      "name": "Mihir",
      "email": null,
      "role": "Owner"
    },
    "languages": ["en"],
    "business": {
      "name": "Cafe & Pizzaro",
      "legal_name": null,
      "industry": "Restaurant / Pizzeria",
      "description": "Experience the best of both worlds at Cafe & Pizzaro! Our menu features a delicious range of traditional pizzas, crafted with timeless flavors and freshly baked crusts. But that's not all - our gourmet pizzas take flavor to the next level with unique toppings and creative combinations. Whether you're a classic margherita fan or an adventurous foodie, Cafe & Pizzaro has something for everyone. Come visit us and discover your new favorite pizza spot!",
      "founded_year": null,
      "existing_website_url": "https://www.pizzaro.com.au/",
      "social_profiles": [],
      "google_business_profile_url": null,
      "locations": [
        {
          "location_id": "richmond",
          "address": "218 Bridge Rd, Richmond VIC 3121, Australia",
          "phone": "0402 567 890",
          "hours": "Mon-Thu 11am-11pm, Fri-Sat 11am-2am, Sun 11am-11pm"
        }
      ]
    },
    "goals": {
      "primary_conversion_goal": "phone calls",
      "secondary_goals": ["online menu views", "directions/hours lookup", "online orders via existing NextOrder link"]
    },
    "content_inventory": [
      {
        "page": "Home",
        "sections": ["hero", "highlights", "reviews", "hours/location", "cta"],
        "text_source": "scraper_sourced",
        "media_source": "needs_sourcing",
        "represents_real_subject": false,
        "notes": "Hero should directly address what he flagged as missing on the current site: real menu visible, real reviews shown."
      },
      {
        "page": "Menu",
        "sections": ["menu items with prices"],
        "text_source": "needs_writing",
        "media_source": "client_provides",
        "represents_real_subject": true,
        "notes": "REAL MENU LIVES AT https://cafe-and-pizzaro-richmond.nextorder.com/ — a live online ordering platform (NextOrder), not a static page. This is very likely JS-rendered (ordering widgets typically are), which is exactly the case scraper-agent.md's own header flags as a weak spot for WebFetch (no JS execution) — expect this to come back thin/empty, not a clean scrape. Fallback plan: get the actual menu items/prices as a photo or text list directly from Mihir rather than relying on scraping this URL. Try the scrape first (cheap, might work), but don't block on it — this is exactly the completeness-check scenario the scraper agent is designed to flag rather than silently pad."
      },
      {
        "page": "About",
        "sections": ["story", "team photo"],
        "text_source": "scraper_sourced",
        "media_source": "needs_sourcing",
        "represents_real_subject": true,
        "notes": "His own words from the current site's About section are already captured in business.description above — reuse_safe (own_site, his own copy)."
      },
      {
        "page": "Contact",
        "sections": ["contact form", "map", "hours"],
        "text_source": "scraper_sourced",
        "media_source": "scraper_sourced",
        "represents_real_subject": false,
        "notes": null
      }
    ],
    "design_direction": {
      "style_words": ["warm", "modern", "appetizing"],
      "avoid": ["corporate", "stock-photo-heavy", "cluttered"],
      "reference_sites": [],
      "brand_assets": {
        "logo_url": "[FILL IN if he has one — check pizzaro.com.au or ask him directly]",
        "existing_colors": [],
        "existing_fonts": []
      }
    },
    "functional_requirements": {
      "forms": [
        {
          "name": "Contact",
          "fields": ["name", "email", "message"],
          "destination_email": null
        }
      ],
      "payments": {"required": false, "provider": null},
      "cms": {"required": false, "type": null},
      "scheduling": {"required": false, "provider": null},
      "live_chat": {"required": false, "provider": null},
      "newsletter": {"required": false, "provider": null},
      "integrations": ["NextOrder online ordering — external link/button to https://cafe-and-pizzaro-richmond.nextorder.com/, not rebuilt or embedded; he already has a working ordering system, no reason to re-engineer it"]
    },
    "constraints": {
      "domain": null,
      "timeline_deadline": null,
      "budget_tier": "starter",
      "compliance": {
        "accessibility_level": "AA",
        "privacy_regime": "none"
      }
    },
    "acceptance_criteria": [
      {"criterion": "Menu is visible and readable on the site", "verification_method": "manual review against client-provided menu"},
      {"criterion": "Google reviews display on the homepage", "verification_method": "QA visual check of reviews section"},
      {"criterion": "Contact form successfully sends a test message", "verification_method": "QA submits test form data end to end"},
      {"criterion": "Order Online button correctly links to the existing NextOrder page", "verification_method": "QA click-through check"},
      {"criterion": "Site displays correctly on mobile", "verification_method": "QA screenshot check at mobile breakpoint"}
    ]
  }
}
```

- [ ] **Step 2: Validate the migrated `kickoff.json`**

Run: `bun scripts/validate-kickoff.ts clients/cafe-and-pizzaro-richmond/.pipeline/kickoff.json`
Expected: exit code 0, `{"status":"valid",...}`. (Before this migration, this file failed — `email` was a non-email placeholder string. Note the pass here for the Task 10 report.)

- [ ] **Step 3: Migrate `scraper-output.json`**

Replace `clients/cafe-and-pizzaro-richmond/.pipeline/scraper-output.json` in full — reshape `business_info`/`reviews` into the v2 arrays, `location_id: "richmond"`, `schema_version: "2.0"`, all other content byte-identical:

```json
{
  "schema_version": "2.0",
  "client_id": "cafe-and-pizzaro-richmond",
  "last_updated_at": "2026-07-24T16:05:00Z",
  "last_updated_by": "scraper-agent",
  "data": {
    "scrape_mode": "own_site",
    "completeness": "good",
    "business_info": {
      "name": {
        "value": "Cafe & Pizzaro",
        "source": "own_site",
        "confidence": "verified"
      },
      "categories": {
        "value": ["Pizza", "Cafe", "Gourmet Pizza"],
        "source": "own_site",
        "confidence": "verified"
      },
      "price_level": {
        "value": "$$",
        "source": "web_search",
        "confidence": "inferred"
      },
      "locations": [
        {
          "location_id": "richmond",
          "address": {
            "value": "218 Bridge Rd, Richmond VIC 3121, Australia",
            "source": "own_site",
            "confidence": "verified"
          },
          "phone": {
            "value": "0402 567 890",
            "source": "own_site",
            "confidence": "verified"
          },
          "hours": {
            "value": "Mon-Thu 11am-11pm, Fri-Sat 11am-2am, Sun 11am-11pm",
            "source": "own_site",
            "confidence": "verified"
          }
        }
      ]
    },
    "reviews": {
      "by_location": [
        {
          "location_id": "richmond",
          "aggregate_rating": {
            "value": 4.8,
            "source": "places_api",
            "confidence": "verified"
          },
          "review_count": {
            "value": 135,
            "source": "places_api",
            "confidence": "verified"
          },
          "places_place_id": {
            "value": "ChIJoTsqIZBD1moRaOPKvVFrSi4",
            "source": "places_api",
            "confidence": "verified"
          },
          "live_display": {
            "mode": "live_fetch",
            "max_results": 5,
            "sort": "most_recent",
            "note": "Live reviews fetched from Google Places API via place_id. Reviews are cached short-term per Google Places ToS compliance (detailed review text regenerated on each backend fetch, not persisted in this output)."
          }
        }
      ],
      "own_site_testimonials": []
    },
    "content_found": [
      {
        "page_guess": "Homepage",
        "url": "https://www.pizzaro.com.au/",
        "source": "own_site",
        "reuse_safe": true,
        "text_blocks": [
          "Cafe & Pizzaro",
          "A Slice Above, A Cup Besides!",
          "Experience the best of both worlds at Cafe & Pizzaro! Our menu features a delicious range of traditional pizzas, crafted with timeless flavors and freshly baked crusts. But that's not all - our gourmet pizzas take flavor to the next level with unique toppings and creative combinations. Whether you're a classic margherita fan or an adventurous foodie, Cafe & Pizzaro has something for everyone. Come visit us and discover your new favorite pizza spot!",
          "Monday - Thursday: 11 am - 11 pm",
          "Friday - Saturday: 11 am - 2 am",
          "Sunday: 11 am - 11 pm",
          "218 Bridge Rd, Richmond VIC 3121, Australia",
          "0402 567 890",
          "Online ordering available via NextOrder platform"
        ],
        "images": [
          {
            "url": "https://images.squarespace-cdn.com/content/v1/6978069627574f0ff1462d31/06a508b4-1a7e-495f-bedf-c529d8aea076/logo+%281%29.png",
            "alt_text": "Cafe & Pizzaro logo",
            "reuse_safe": true
          },
          {
            "url": "https://images.squarespace-cdn.com/content/v1/6978069627574f0ff1462d31/13634b7d-fd20-4892-b906-e62fe33714a9/605894293_122140837400958590_180364943896900253_n.jpg",
            "alt_text": "Customer holding up a folded pizza slice",
            "reuse_safe": true
          }
        ]
      },
      {
        "page_guess": "NextOrder Menu Platform",
        "url": "https://cafe-and-pizzaro-richmond.nextorder.com/",
        "source": "own_site",
        "reuse_safe": true,
        "text_blocks": [
          "Cafe and Pizzaro Richmond",
          "Pizza offerings available through NextOrder online ordering platform"
        ],
        "images": []
      }
    ],
    "social_profiles_found": [
      "https://www.instagram.com/cafeandpizzarorichmond/",
      "https://www.facebook.com/61578757710244"
    ],
    "scrape_notes": [
      "scrape_mode: own_site (existing_website_url present in kickoff.json)",
      "Primary source was pizzaro.com.au homepage (Squarespace-based)",
      "Standard subpage URLs (/about, /contact, /menu) all returned 404 — business info consolidated on homepage only",
      "NextOrder menu platform at https://cafe-and-pizzaro-richmond.nextorder.com/ returned minimal content (JavaScript-rendered, WebFetch unable to execute client-side code) — no specific menu items or prices extracted",
      "Price level ($$ mid-range) inferred from web_search data showing pizzas priced $17-20 AUD on Uber Eats delivery platform",
      "Social profiles (Instagram, Facebook) discovered on homepage but no live social media content scraped (those belong in backend's live integrations, not this normalized output)",
      "No testimonials found on own website homepage — reviews section not implemented on current Squarespace site",
      "NextOrder integration is external link/button as per kickoff.json functional_requirements, not an embedded menu — actual menu sourcing to be handled via client-provided content or additional NextOrder API integration if required by design/backend",
      "Places API lookup completed successfully after GOOGLE_PLACES_API_KEY was added to environment — place_id ChIJoTsqIZBD1moRaOPKvVFrSi4 matched and verified against kickoff.json business name and address",
      "Reviews data retrieved from Places API: 4.8/5 aggregate rating across 135 reviews; sampled reviews ranged from approximately 1 week to 6 months old (aggregate recency only — no individual review text or reviewer names retained in this file, per Places API compliance)",
      "Five sample reviews cached to ephemeral .pipeline/scraper-cache/places-reviews-preview.json for design preview — individual review text NOT persisted in this output per Google Places ToS compliance (regenerated live during backend implementation)",
      "Completeness upgraded to 'good': core business_info (name, address, phone) all verified from own_site source, content_found has multiple usable text blocks (homepage text thin but present), and reviews block now populated with aggregate_rating and review_count from Places API",
      "TARGETED RE-SCRAPE (2026-07-29): original scrape used WebFetch's markdown rendering, which does not reconstruct lazy-loaded (data-src) images, so the homepage's real logo and photos were invisible to it and wrongly read as absent. Fetched the raw HTML directly via curl this time and grepped for data-src/srcset/background-image patterns to check for real assets before concluding none exist — same methodology that previously caught RG Detailing's lazy-loaded gallery, but the outcome here is different and was verified image-by-image, not assumed to match.",
      "Real logo FOUND: eager-loaded (not even lazy) header logo at images.squarespace-cdn.com/.../06a508b4.../logo+(1).png — an illustrated 'Cafe & Pizzaro' wordmark with a pizza-slice/coffee-cup mark, confirmed by downloading and viewing it directly. Added to content_found's Homepage images. This resolves kickoff.json's business.brand_assets.logo_url placeholder ('[FILL IN if he has one...]') — human/intake should copy this URL in, since kickoff.json is out of scraper-agent's write scope.",
      "One real photo FOUND and added: a standalone homepage image block (not part of the gallery below) at images.squarespace-cdn.com/.../13634b7d-.../605894293_122140837400958590_180364943896900253_n.jpg — filename matches an Instagram CDN export pattern, and this business's Instagram is already in social_profiles_found. Viewed directly: a genuine photo of a customer holding up a pizza slice. Marked reuse_safe.",
      "A homepage 'Gallery Reel' section (6 images, lazy-loaded, elementtiming=nbf-gallery-reel-item) was found but deliberately NOT added to content_found after checking each one: 2 of the 6 files are literally named generated_<timestamp>.png (confirmed AI-generated, not a guess), and the remaining 4 are visually indistinguishable from those 2 when downloaded and viewed — identical top-down framing, identical bamboo-board background, identical studio lighting, no interior/exterior/staff context that would suggest an actual on-site photo. Assessed as a synthetic/stock placeholder gallery (likely a page-builder template default), not real photos of this business's actual food. Per this project's compliance rule against pairing ai_generated media with represents_real_subject:true, these were excluded rather than added as reuse_safe real content — flagging here so design/backend don't mistake this section for genuine food photography if they browse the live site directly.",
      "A repeating decorative background pattern (aaa-02.png, appears 3x as a fluid-engine 'section-background' element) was also checked and excluded: it's a generic line-art food-doodle texture (eggs, fries, hot dog, pizza slice icons on a red background), not a photo of the business — standard Squarespace template decoration, not client content.",
      "Conclusion is now a checked one, not a re-statement of the original miss: a real logo exists and was missed by the first pass; genuine homepage photos also exist (one added); a separate gallery section that looks superficially like more real photos is actually synthetic and was correctly excluded rather than blindly harvested."
    ]
  }
}
```

- [ ] **Step 4: Validate the migrated `scraper-output.json`**

Run this ad-hoc check (no dedicated CLI for `scraper-output.json` exists — this is a one-off `bun -e` snippet, reusing the same compile pattern as `tests/schemas/helpers.ts`):

```bash
bun -e '
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync("schemas/common.schema.json", "utf-8")), "common.schema.json");
ajv.addSchema(JSON.parse(readFileSync("schemas/scraper-output.schema.json", "utf-8")), "scraper-output.schema.json");
const validate = ajv.getSchema("scraper-output.schema.json");
const data = JSON.parse(readFileSync("clients/cafe-and-pizzaro-richmond/.pipeline/scraper-output.json", "utf-8"));
const ok = validate(data);
console.log(JSON.stringify({ path: "clients/cafe-and-pizzaro-richmond/.pipeline/scraper-output.json", status: ok ? "valid" : "invalid", errors: validate.errors ?? null }));
'
```

Expected: `{"path":"clients/cafe-and-pizzaro-richmond/.pipeline/scraper-output.json","status":"valid","errors":null}`.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS, unchanged counts (these are files under gitignored `clients/`, not exercised by any `bun test` file).

- [ ] **Step 6: No `git add` needed**

`clients/` is gitignored — these file edits are on-disk state changes for a live client, not something this repo's git history tracks. Do not attempt `git add clients/...`.

---

### Task 8: Migrate `rg-detailing-geelong`'s pipeline files to v2

**Files:**
- Modify: `clients/rg-detailing-geelong/.pipeline/kickoff.json`
- Modify: `clients/rg-detailing-geelong/.pipeline/scraper-output.json`

**Interfaces:**
- Consumes: same as Task 7.

- [ ] **Step 1: Migrate `kickoff.json`**

Replace `clients/rg-detailing-geelong/.pipeline/kickoff.json` in full — `schema_version` to `"2.0"`, `location_id: "geelong"` added. `primary_contact.email` is already a real address (`richie@rgdetailing.com.au`) — no change needed there:

```json
{
  "schema_version": "2.0",
  "client_id": "rg-detailing-geelong",
  "last_updated_at": "2026-07-27T11:44:00Z",
  "last_updated_by": "human",
  "data": {
    "primary_contact": {
      "name": "[FILL IN if known — otherwise scraper may find a contact name; not required to start]",
      "email": "richie@rgdetailing.com.au",
      "role": "Owner"
    },
    "languages": ["en"],
    "business": {
      "name": "[FILL IN if known, otherwise scraper will pull this from the site]",
      "legal_name": null,
      "industry": "Automotive Detailing",
      "description": "[Leave blank — scraper_sourced from their own site]",
      "founded_year": null,
      "existing_website_url": "https://rgdetailing.com.au/",
      "social_profiles": [],
      "google_business_profile_url": null,
      "locations": [
        {"location_id": "geelong", "address": "[FILL IN if known, otherwise scraper-sourced]", "phone": "[FILL IN if known, otherwise scraper-sourced]", "hours": "[FILL IN if known, otherwise scraper-sourced]"}
      ]
    },
    "goals": {
      "primary_conversion_goal": "phone calls / booking inquiries",
      "secondary_goals": ["service menu views", "before/after gallery views", "directions/hours lookup"]
    },
    "content_inventory": [
      {"page": "Home", "sections": ["hero", "services highlight", "reviews", "before/after", "cta"], "text_source": "scraper_sourced", "media_source": "needs_sourcing", "represents_real_subject": true, "notes": "This is a cold-outreach prototype — no client relationship yet. Real before/after photos aren't available; use clearly-labeled placeholders, not AI-generated stand-ins for real cars/work."},
      {"page": "Services", "sections": ["service list with pricing if public"], "text_source": "scraper_sourced", "media_source": "scraper_sourced", "represents_real_subject": false, "notes": null},
      {"page": "Contact", "sections": ["contact form", "map", "hours"], "text_source": "scraper_sourced", "media_source": "scraper_sourced", "represents_real_subject": false, "notes": null},
      {"page": "Gallery", "sections": ["before/after work showcase"], "text_source": "scraper_sourced", "media_source": "scraper_sourced", "represents_real_subject": true, "notes": "Real photos of actual completed work now confirmed available via scraper-output.json's content_found — download and host these as real static assets in this site's own public/images/ during build, don't hotlink to rgdetailing.com.au's URLs directly."}
    ],
    "design_direction": {
      "style_words": ["premium", "sleek", "precise"],
      "avoid": ["cheap/DIY-looking", "cluttered", "generic-template"],
      "reference_sites": [],
      "brand_assets": {"logo_url": "https://rgdetailing.com.au/pub/img/website-logo.webp", "existing_colors": [], "existing_fonts": []}
    },
    "functional_requirements": {
      "forms": [{"name": "Booking Inquiry", "fields": ["name", "email", "vehicle", "message"], "destination_email": null}],
      "payments": {"required": false, "provider": null},
      "cms": {"required": false, "type": null},
      "scheduling": {"required": false, "provider": null},
      "live_chat": {"required": false, "provider": null},
      "newsletter": {"required": false, "provider": null},
      "integrations": []
    },
    "constraints": {
      "domain": null,
      "timeline_deadline": null,
      "budget_tier": "premium",
      "compliance": {"accessibility_level": "AA", "privacy_regime": "none"}
    },
    "acceptance_criteria": [
      {"criterion": "Homepage reflects RG Detailing's real services and hours", "verification_method": "manual review against their live site"},
      {"criterion": "Design visibly reads as premium, not templated", "verification_method": "manual review before sending to prospect"}
    ]
  }
}
```

- [ ] **Step 2: Validate the migrated `kickoff.json`**

Run: `bun scripts/validate-kickoff.ts clients/rg-detailing-geelong/.pipeline/kickoff.json`
Expected: exit code 0, `{"status":"valid",...}`.

- [ ] **Step 3: Migrate `scraper-output.json`**

Replace `clients/rg-detailing-geelong/.pipeline/scraper-output.json` in full — reshape into v2, `location_id: "geelong"`, `schema_version: "2.0"`, all other content byte-identical:

```json
{
  "schema_version": "2.0",
  "client_id": "rg-detailing-geelong",
  "last_updated_at": "2026-07-27T07:04:00Z",
  "last_updated_by": "scraper-agent",
  "data": {
    "scrape_mode": "own_site",
    "completeness": "good",
    "business_info": {
      "name": {
        "value": "RGDETAILING",
        "source": "own_site",
        "confidence": "verified"
      },
      "categories": {
        "value": [
          "Automotive Detailing",
          "Ceramic Coating",
          "Paint Correction"
        ],
        "source": "own_site",
        "confidence": "verified"
      },
      "price_level": {
        "value": null,
        "source": "not_found",
        "confidence": "missing"
      },
      "locations": [
        {
          "location_id": "geelong",
          "address": {
            "value": "Unit 3/56 Slevin Street, North Geelong VIC 3215, Australia",
            "source": "own_site",
            "confidence": "verified"
          },
          "phone": {
            "value": "0438 781 340",
            "source": "own_site",
            "confidence": "verified"
          },
          "hours": {
            "value": "Monday-Friday: 8:30 AM – 5:00 PM, Saturday-Sunday: Closed",
            "source": "places_api",
            "confidence": "verified"
          }
        }
      ]
    },
    "reviews": {
      "by_location": [
        {
          "location_id": "geelong",
          "aggregate_rating": {
            "value": 5.0,
            "source": "places_api",
            "confidence": "verified"
          },
          "review_count": {
            "value": 118,
            "source": "places_api",
            "confidence": "verified"
          },
          "places_place_id": {
            "value": "ChIJWXkqMIcX1GoRFOnphzUDnGM",
            "source": "places_api",
            "confidence": "verified"
          },
          "live_display": {
            "mode": "live_fetch",
            "max_results": 5,
            "sort": "most_recent",
            "note": "Business has active Google Business Profile with 118 verified reviews and 5.0 rating. Live-fetch recommended to display current testimonials."
          }
        }
      ],
      "own_site_testimonials": []
    },
    "content_found": [
      {
        "page_guess": "Home",
        "url": "https://rgdetailing.com.au/",
        "source": "own_site",
        "reuse_safe": true,
        "text_blocks": [
          "RGDETAILING - Automotive Detailing Services",
          "We provide unparalleled automotive care, combining cutting-edge technology with meticulous attention to detail. We recognize that vehicles are investments and extensions of personal identity.",
          "Services Offered: Ceramic Coating, Paint Correction, Car Detailing Packages, Paint Protection",
          "Contact: Richie, richie@rgdetailing.com.au, 0438 781 340",
          "Address: 3/56 Slevin Street, North Geelong",
          "Business Hours: 8AM - 6PM, Monday - Saturday",
          "Service Area: Covers 23+ suburbs including Armstrong Creek, Belmont, Geelong West, Highton, Lara, Leopold, Newtown, South Geelong, Torquay, Waurn Ponds, and surrounding Geelong localities"
        ],
        "images": [
          {
            "url": "https://rgdetailing.com.au/pub/img/website-logo.webp",
            "alt_text": "RGDETAILING logo",
            "reuse_safe": true
          }
        ]
      },
      {
        "page_guess": "About",
        "url": "https://rgdetailing.com.au/about",
        "source": "own_site",
        "reuse_safe": true,
        "text_blocks": [
          "Company Mission: Provide unparalleled automotive care, combining cutting-edge technology with meticulous attention to detail",
          "Vehicle Philosophy: Vehicles are recognized as investments and extensions of personal identity",
          "Ceramic Coating Service: Advanced protective layers that shield vehicles from UV rays and environmental contaminants while enhancing paint depth and gloss",
          "Paint Correction Service: Professional restoration using state-of-the-art equipment to eliminate swirls, scratches, and imperfections",
          "Detailing Packages: Comprehensive care covering all vehicle areas, both interior and exterior",
          "Contact: Richie, richie@rgdetailing.com.au, 0438 781 340",
          "Address: 3/56 Slevin Street, North Geelong",
          "Service Area: 23 suburbs including Armstrong Creek, Belmont, Geelong West, Highton, Lara, Leopold, Newtown, South Geelong, Torquay, Waurn Ponds, and surrounding Geelong localities"
        ],
        "images": []
      },
      {
        "page_guess": "Services",
        "url": "https://rgdetailing.com.au/services",
        "source": "own_site",
        "reuse_safe": true,
        "text_blocks": [
          "Car Ceramic Coating - CAR CERAMIC COATING GEELONG: Protective coating service offered in the Geelong area",
          "Paint Correction - CAR PAINT CORRECTION GEELONG: Restoration service to address paint imperfections",
          "Premium Car Detailing - PREMIUM CAR DETAILING GEELONG: Comprehensive vehicle cleaning and finishing services",
          "Pre-Sale Detailing - PRE-SALE CAR DETAILING GEELONG: Preparation service for vehicles being sold",
          "Service Area: Business serves 23+ suburbs including Geelong West, Highton, Torquay, Armstrong Creek, Belmont, Corio, Grovedale, Lara, Leopold, Manifold Heights, Newtown, and others throughout the greater Geelong region",
          "Contact: richie@rgdetailing.com.au, 0438 781 340",
          "Address: 3/56 Slevin Street, North Geelong",
          "Hours: 8AM - 6PM, Monday - Saturday"
        ],
        "images": []
      },
      {
        "page_guess": "Contact",
        "url": "https://rgdetailing.com.au/contact",
        "source": "own_site",
        "reuse_safe": true,
        "text_blocks": [
          "Contact Information",
          "Address: 3/56 Slevin Street, North Geelong",
          "Phone: 0438 781 340",
          "Email: richie@rgdetailing.com.au",
          "Hours of Operation: 8AM - 6PM, Monday - Saturday",
          "Contact Form Available: Requests customer name, email, phone number, vehicle details (make/model/year), interior condition information, and message field",
          "Location GPS Coordinates: -38.119082, 144.350863",
          "Google Maps Integration: Click to navigate option available",
          "Service Area: 23+ suburbs in Geelong region including Armstrong Creek, Belmont, Torquay, Waurn Ponds, and surrounding areas"
        ],
        "images": []
      },
      {
        "page_guess": "Gallery",
        "url": "https://rgdetailing.com.au/gallery/geelong",
        "source": "own_site",
        "reuse_safe": true,
        "text_blocks": [
          "Gallery of detailing and ceramic coating services completed in Geelong and surrounding suburbs. Showcases real examples of professional automotive detailing work, paint correction, and ceramic coating applications."
        ],
        "images": [
          {"url": "https://rgdetailing.com.au/pub/img/gallery/1000006985.webp", "alt_text": "Vehicle detailing service in progress", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/20240103_145030.webp", "alt_text": "Completed detailing work — Geelong", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/20240501_141835.webp", "alt_text": "Professional detailing service result", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/IMG_20240419_214645_680.webp", "alt_text": "Ceramic coating application on vehicle", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/car-detailing-geelong.webp", "alt_text": "Professional car detailing in Geelong", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/detailing-geelong-ceramic-coat.webp", "alt_text": "Ceramic coating service demonstration", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/geelong-ceramic-coating-2.webp", "alt_text": "Ceramic coating results — Geelong", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/geelong-detailer-e1697448542887.webp", "alt_text": "RGDETAILING professional at work", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/mustang-geelong-detailing.webp", "alt_text": "Mustang vehicle detailing in progress", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/paint-protection-geelong-scaled.webp", "alt_text": "Paint protection film application — Geelong", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/rgdetailing-car-detailing-geelong-1-scaled.webp", "alt_text": "RGDETAILING professional detailing showcase", "reuse_safe": true},
          {"url": "https://rgdetailing.com.au/pub/img/gallery/rgdetailing-ceramic-coatings.webp", "alt_text": "Ceramic coating work on vehicle", "reuse_safe": true}
        ]
      }
    ],
    "social_profiles_found": [
      "https://www.facebook.com/people/RGDETAILING/100076244168288/"
    ],
    "scrape_notes": [
      "Primary scrape mode: own_site. Website crawl successful, retrieved business name, address, phone, hours, service categories, and contact information.",
      "Places API lookup successful. Matched business on Google Business Profile (place_id: ChIJWXkqMIcX1GoRFOnphzUDnGM). Retrieved verified rating (5.0 stars) and review count (118 reviews).",
      "Note on hours discrepancy: Website states '8AM - 6PM, Monday - Saturday' but Google Business Profile shows more specific hours: Monday-Friday 8:30 AM – 5:00 PM, Saturday-Sunday Closed. Places API data used as authoritative source for hours field.",
      "Pricing information: No public pricing listed on website. Price level marked as not_found.",
      "No customer testimonials found on the business's own website. Business has strong Google Places presence with 118 reviews all rated 5 stars. Review samples saved to ephemeral cache for design mockup purposes.",
      "One social profile found: Facebook page linked.",
      "Completeness assessment: GOOD - All core business info (name, address, phone, hours) verified from own_site; categories identified; Places API ratings available; multiple content text blocks captured.",
      "Gallery verification correction (2026-07-27): Initial assessment incorrectly concluded no genuine gallery existed, based on observing the site's catch-all page behavior for arbitrary /gallery/<suburb> paths. However, deeper inspection of raw HTML revealed the gallery content does exist — it is implemented via lazy-loading with a custom cGallery.js script that loads images from data-img attributes, not standard <img> tags. WebFetch's markdown rendering does not reconstruct lazy-loaded assets, which caused the initial miss. A real, populated 12-photo gallery is reachable at /gallery/geelong (as well as /gallery/<any-suburb-slug>, real or fake — the gallery is not suburb-differentiated, it is a single shared gallery served across all /gallery/* paths). All 12 images verified as real WebP photos of actual detailing work (hundreds of KB each). Gallery now added to content_found with all images listed."
    ]
  }
}
```

- [ ] **Step 4: Validate the migrated `scraper-output.json`**

Run:

```bash
bun -e '
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync("schemas/common.schema.json", "utf-8")), "common.schema.json");
ajv.addSchema(JSON.parse(readFileSync("schemas/scraper-output.schema.json", "utf-8")), "scraper-output.schema.json");
const validate = ajv.getSchema("scraper-output.schema.json");
const data = JSON.parse(readFileSync("clients/rg-detailing-geelong/.pipeline/scraper-output.json", "utf-8"));
const ok = validate(data);
console.log(JSON.stringify({ path: "clients/rg-detailing-geelong/.pipeline/scraper-output.json", status: ok ? "valid" : "invalid", errors: validate.errors ?? null }));
'
```

Expected: `{"path":"clients/rg-detailing-geelong/.pipeline/scraper-output.json","status":"valid","errors":null}`.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS, unchanged counts.

- [ ] **Step 6: No `git add` needed** (same reason as Task 7 — `clients/` is gitignored).

---

### Task 9: Migrate Chaiverse's `kickoff.json` to v2

**Files:**
- Modify: `clients/chaiverse/.pipeline/kickoff.json` (already moved to this path in a prior session — confirm it's there before editing)

**Interfaces:**
- Consumes: `kickoff.schema.json` v2 (Task 2), `scripts/validate-kickoff.ts` (Task 5).

- [ ] **Step 1: Confirm the file is at the correct path**

Run: `ls clients/chaiverse/.pipeline/kickoff.json`
Expected: file exists (moved there in a prior session from `clients/chaiverse/kickoff-chaiverse.json`).

- [ ] **Step 2: Add `location_id` to both locations and bump `schema_version`**

Replace `clients/chaiverse/.pipeline/kickoff.json` in full — `schema_version` to `"2.0"`, `location_id: "geelong"`/`"werribee"` added to the two locations, everything else byte-identical (including the already-`null` `primary_contact.email`):

```json
{
  "schema_version": "2.0",
  "client_id": "chaiverse",
  "last_updated_at": "2026-08-25T00:00:00Z",
  "last_updated_by": "human",
  "data": {
    "primary_contact": {
      "name": "Sagar",
      "email": null,
      "role": "Owner"
    },
    "languages": [
      "en"
    ],
    "business": {
      "name": "Chaiverse",
      "legal_name": null,
      "industry": "Indian Street Food / Chai Cafe",
      "description": "Chai. Chaat. Good Vibes. Chaiverse is our take on the feeling of home — a cosy space, bringing together authentic Indian chai, street food and the flavours we grew up loving. From kadak masala chai and refreshing lassis to vada pav, pani puri, samosa chaat and more, our menu is inspired by the streets, cafés and kitchens of India. Whether you're here for a quick cup of chai, a late-night snack or a catch-up with friends, Chaiverse is a place to eat, unwind and make memories. Authentic flavours. Warm vibes. A little taste of home.",
      "founded_year": null,
      "existing_website_url": "https://www.chaiverse.au/",
      "social_profiles": [],
      "google_business_profile_url": null,
      "locations": [
        {
          "location_id": "geelong",
          "address": "23 Cuzens Place, Geelong, VIC 3220, Australia",
          "phone": "+61 401 188 283",
          "hours": "[FILL IN or scraper-sourced via Places, per-location]"
        },
        {
          "location_id": "werribee",
          "address": "6/57-61 Synnot St, Werribee, VIC 3030, Australia",
          "phone": "[FILL IN if different from the Geelong number]",
          "hours": "[FILL IN or scraper-sourced via Places, per-location]"
        }
      ]
    },
    "goals": {
      "primary_conversion_goal": "online orders (redirect to existing ordering platform)",
      "secondary_goals": [
        "menu views",
        "directions/hours lookup per branch",
        "phone calls"
      ]
    },
    "content_inventory": [
      {
        "page": "Home",
        "sections": [
          "hero",
          "highlights",
          "reviews",
          "locations",
          "cta"
        ],
        "text_source": "needs_writing",
        "media_source": "needs_sourcing",
        "represents_real_subject": false,
        "notes": "No marketing homepage currently exists — chaiverse.au IS the ordering menu, confirmed via direct check (root URL and /about both render identical menu content). This page is being built from nothing, not adapted from existing copy."
      },
      {
        "page": "Menu",
        "sections": [
          "menu items with prices"
        ],
        "text_source": "scraper_sourced",
        "media_source": "scraper_sourced",
        "represents_real_subject": true,
        "notes": "Real, extensive menu with real prices already confirmed present and scrapeable directly from chaiverse.au — unlike Cafe & Pizzaro/RG Detailing, no JS-lazy-load or separate-platform issue expected here, this is the easy case."
      },
      {
        "page": "Locations",
        "sections": [
          "Geelong branch",
          "Werribee branch",
          "hours per branch",
          "map per branch"
        ],
        "text_source": "client_provides",
        "media_source": "needs_sourcing",
        "represents_real_subject": false,
        "notes": "New page type for this pipeline — first multi-location client. See open schema question before scraper runs."
      },
      {
        "page": "Contact",
        "sections": [
          "contact form",
          "hours",
          "phone"
        ],
        "text_source": "client_provides",
        "media_source": "scraper_sourced",
        "represents_real_subject": false,
        "notes": null
      }
    ],
    "design_direction": {
      "style_words": [
        "vibrant",
        "bold",
        "energetic"
      ],
      "avoid": [
        "muted/pastel",
        "corporate",
        "generic-template"
      ],
      "reference_sites": [],
      "brand_assets": {
        "logo_url": "[FILL IN — real logo confirmed visible on-site, top-left of chaiverse.au; scraper should extract it directly]",
        "existing_colors": [
          "#F5B400 (approx., primary yellow/gold from logo + combo-card backgrounds)",
          "#E53935 (approx., red accent from pricing badges)"
        ],
        "existing_fonts": []
      }
    },
    "functional_requirements": {
      "forms": [
        {
          "name": "Contact",
          "fields": [
            "name",
            "email",
            "message"
          ],
          "destination_email": null
        }
      ],
      "payments": {
        "required": false,
        "provider": null
      },
      "cms": {
        "required": false,
        "type": null
      },
      "scheduling": {
        "required": false,
        "provider": null
      },
      "live_chat": {
        "required": false,
        "provider": null
      },
      "newsletter": {
        "required": false,
        "provider": null
      },
      "integrations": [
        "Existing Chaiverse ordering platform (chaiverse.au) — external link/button, not rebuilt or embedded. Revisit if they later want it replaced, per Sagar not having decided yet."
      ]
    },
    "constraints": {
      "domain": null,
      "timeline_deadline": null,
      "budget_tier": "starter",
      "compliance": {
        "accessibility_level": "AA",
        "privacy_regime": "none"
      }
    },
    "acceptance_criteria": [
      {
        "criterion": "Both Geelong and Werribee branches are clearly and separately represented (address, hours, map)",
        "verification_method": "manual review — first multi-location client, check this specifically"
      },
      {
        "criterion": "Menu content matches the real chaiverse.au ordering menu",
        "verification_method": "manual spot-check against live ordering site"
      },
      {
        "criterion": "Order Online buttons correctly link to the existing chaiverse.au ordering flow",
        "verification_method": "QA click-through check"
      },
      {
        "criterion": "Site reflects the real brand palette (yellow/gold primary, red accent) from the existing logo",
        "verification_method": "manual review against logo"
      }
    ]
  }
}
```

- [ ] **Step 3: Validate the migrated `kickoff.json`**

Run: `bun scripts/validate-kickoff.ts clients/chaiverse/.pipeline/kickoff.json`
Expected: exit code 0, `{"status":"valid",...}`.

- [ ] **Step 4: Confirm no `scraper-output.json` exists for Chaiverse yet (expected, not a defect)**

Run: `ls clients/chaiverse/.pipeline/`
Expected: only `kickoff.json` — no `scraper-output.json`. This is correct per the design doc (1.8): the scraper agent hasn't run for this client yet; nothing to migrate or validate there.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS, unchanged counts.

- [ ] **Step 6: No `git add` needed** (same reason as Task 7).

---

### Task 10: Final validation report

**Files:** none created or modified — this task produces the pass/fail report the original request asked for.

**Interfaces:**
- Consumes: everything from Tasks 1-9.

- [ ] **Step 1: Run the full automated test suite**

Run: `bun test`
Expected: PASS. Record the exact pass/fail/skip counts for the report (should be higher than the pre-Task-1 baseline of 196 pass / 6 skip / 0 fail, by exactly the number of new tests added across Tasks 1-3).

- [ ] **Step 2: Validate all three clients' `kickoff.json` files individually**

Run each separately (not in a loop — each result must be reported individually per the original request):

```bash
bun scripts/validate-kickoff.ts clients/cafe-and-pizzaro-richmond/.pipeline/kickoff.json
bun scripts/validate-kickoff.ts clients/rg-detailing-geelong/.pipeline/kickoff.json
bun scripts/validate-kickoff.ts clients/chaiverse/.pipeline/kickoff.json
```

Expected: all three print `{"status":"valid",...}` and exit 0.

- [ ] **Step 3: Validate both existing clients' `scraper-output.json` files individually**

Run each separately:

```bash
bun -e '
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync("schemas/common.schema.json", "utf-8")), "common.schema.json");
ajv.addSchema(JSON.parse(readFileSync("schemas/scraper-output.schema.json", "utf-8")), "scraper-output.schema.json");
const validate = ajv.getSchema("scraper-output.schema.json");
const path = "clients/cafe-and-pizzaro-richmond/.pipeline/scraper-output.json";
const data = JSON.parse(readFileSync(path, "utf-8"));
console.log(JSON.stringify({ path, status: validate(data) ? "valid" : "invalid", errors: validate.errors ?? null }));
'

bun -e '
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync("schemas/common.schema.json", "utf-8")), "common.schema.json");
ajv.addSchema(JSON.parse(readFileSync("schemas/scraper-output.schema.json", "utf-8")), "scraper-output.schema.json");
const validate = ajv.getSchema("scraper-output.schema.json");
const path = "clients/rg-detailing-geelong/.pipeline/scraper-output.json";
const data = JSON.parse(readFileSync(path, "utf-8"));
console.log(JSON.stringify({ path, status: validate(data) ? "valid" : "invalid", errors: validate.errors ?? null }));
'
```

Expected: both print `"status":"valid"`.

- [ ] **Step 4: Confirm Chaiverse's `scraper-output.json` status**

Run: `ls clients/chaiverse/.pipeline/scraper-output.json`
Expected: "No such file or directory" — report this as "not yet produced" (scraper hasn't run), not as pass/fail, per the design doc's explicit scope decision.

- [ ] **Step 5: Compose the report**

Present to the user a table with one row per (client, file) pair, each independently marked pass/fail/not-yet-produced — not summarized into an aggregate count:

| Client | File | Result |
|---|---|---|
| `cafe-and-pizzaro-richmond` | `kickoff.json` | pass (was failing before migration — placeholder email) |
| `cafe-and-pizzaro-richmond` | `scraper-output.json` | pass |
| `rg-detailing-geelong` | `kickoff.json` | pass |
| `rg-detailing-geelong` | `scraper-output.json` | pass |
| `chaiverse` | `kickoff.json` | pass |
| `chaiverse` | `scraper-output.json` | not yet produced — scraper hasn't run for this client |

Plus the `bun test` summary line from Step 1.

- [ ] **Step 6: No commit** — this task only runs checks and reports results; nothing new to commit.
