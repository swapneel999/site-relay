# Pipeline Schema Formalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved prose design doc (`docs/superpowers/specs/2026-07-03-client-pipeline-state-schema-design.md`) into two concrete, trustworthy artifacts: a full set of JSON Schema files under `schemas/`, and `docs/spec.md` — the field-by-field, read/write-by-whom reference every future agent (scraper, design, backend, QA, integration lead) will be pointed at.

**Architecture:** One `.schema.json` file per pipeline file (7 total), plus a `schemas/common.schema.json` holding shared `$defs` (the envelope's timestamp/hex/url primitives, the `SourcedField<T>` variants, and the shared `category`/`severity` enums) so the 7 files `$ref` into one place instead of repeating definitions. Each schema is proven correct with a passing fixture and a failing fixture, run through `ajv` under `bun test`, before it's considered done. `docs/spec.md` is assembled last, section by section, directly from the same source-of-truth prose already reviewed in the design doc — it does not introduce new decisions.

**Tech Stack:** Bun (test runner + package manager, confirmed installed at 1.3.14), `ajv` (JSON Schema validator, draft-07), `ajv-formats` (for `date-time`/`uri`/`email`/`date` format keywords).

## Global Constraints

- JSON Schema draft: **draft-07** — broadest tooling compatibility, no need for 2020-12-only features here. Every schema file's `$schema` is `http://json-schema.org/draft-07/schema#`.
- Schema files live in `schemas/*.schema.json` at repo root (not under `docs/`) — they're validation artifacts consumed by code (ajv, and later the scraper/design/QA agents), not documentation prose.
- `$id` values are bare relative filenames (e.g. `"common.schema.json"`, `"kickoff.schema.json"`) — not real URLs. This is sufficient for `ajv.addSchema()` resolution and avoids inventing a fake domain.
- The 4 envelope fields (`schema_version`, `client_id`, `last_updated_at`, `last_updated_by`) are written out literally in each of the 7 top-level schemas rather than `$ref`'d as a group — mixing `$ref`/`allOf` with sibling `additionalProperties: false` at the top level is a known JSON Schema (draft-07) footgun (properties defined only inside a `$ref`'d subschema aren't visible to a sibling `additionalProperties: false`), and 4 duplicated lines per file is a case where the DRY violation is cheaper than the workaround. Deeper reusable pieces (timestamp/hex/url formats, `SourcedField<T>` variants, shared enums) are `$ref`'d from `common.schema.json` — those are not adjacent to `additionalProperties: false` in the referencing schema, so no footgun applies.
- Every object schema sets `"additionalProperties": false` unless the design doc explicitly describes a field as a catch-all (there are none in this spec — `functional_requirements.integrations` is a plain string array, not an open object).
- **Resolved:** `SourcedField<T>.value` is `T | null` per the design doc (Section C). The JSON-level representation question — whether the `value` key is always present with an explicit `null`, vs. omitted entirely when data's missing — is settled in favor of **always present, explicit `null`**: every `SourcedField` instance requires all three keys (`value`, `source`, `confidence`), with `value` typed `["string","null"]` (or `["number","null"]` / `["array","null"]`). This lets `required` consistently assert key presence across every instance rather than being conditionally present. Already reflected as-is in `schemas/common.schema.json`'s `sourcedField*` defs below — no schema change needed from this clarification.
- **Known limitation, documented rather than silently glossed over:** `qa-report.json`'s `overall_status`, `round_result`, and the dual-scope `pass_condition` are *computed from history across rounds/findings* (per the design doc's algorithm in that section). Static JSON Schema validates the **shape** of each round/finding, not this cross-record computation — a `qa-report.json` can be shape-valid and still have a `overall_status` that doesn't match what `pass_condition` would compute. `docs/spec.md` documents the algorithm in prose (copied from the design doc) and flags it explicitly as "not schema-enforced — verify with application logic, e.g. an orchestrator-side check," rather than implying the schema catches this class of bug.
- Every schema task follows the same TDD shape: write the fixture(s) and test first (fails because the schema file doesn't exist yet) → write the schema → test passes. Fixtures live at `tests/schemas/fixtures/<file-basename>/valid.json` and `.../invalid-<reason>.json`.

---

## Task 1: Project scaffolding (Bun + ajv)

**Files:**
- Create: `package.json`
- Create: `tests/schemas/helpers.ts`

**Interfaces:**
- Produces: `compileSchema(schemaFileName: string): ValidateFunction` — every later task's test file imports this from `tests/schemas/helpers.ts`. Loads `schemas/common.schema.json` into a fresh `Ajv` instance first, then the named schema, then returns `ajv.getSchema(schemaFileName)`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "website-builder-pipeline-schemas",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test"
  },
  "devDependencies": {
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `bun install`
Expected: `bun.lock` created, `node_modules/ajv` and `node_modules/ajv-formats` present.

- [ ] **Step 3: Write the test helper**

```typescript
// tests/schemas/helpers.ts
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMAS_DIR = join(import.meta.dir, "..", "..", "schemas");

export function compileSchema(schemaFileName: string): ValidateFunction {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);

  const common = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, "common.schema.json"), "utf-8")
  );
  ajv.addSchema(common, "common.schema.json");

  const target = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, schemaFileName), "utf-8")
  );
  ajv.addSchema(target, schemaFileName);

  const validate = ajv.getSchema(schemaFileName);
  if (!validate) {
    throw new Error(`ajv failed to compile ${schemaFileName}`);
  }
  return validate;
}

export function loadFixture(fileBasename: string, fixtureName: string): unknown {
  const path = join(
    import.meta.dir,
    "fixtures",
    fileBasename,
    `${fixtureName}.json`
  );
  return JSON.parse(readFileSync(path, "utf-8"));
}
```

- [ ] **Step 4: Verify the helper at least loads (expected to fail — no schemas exist yet)**

Run: `bun test`
Expected: no test files matched yet (0 tests) — this just confirms `bun test` runs without a syntax/import error in `helpers.ts`. If it errors on the `common.schema.json` read inside `compileSchema`, that's fine too (no test calls it yet); a bare import error is not.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/schemas/helpers.ts
git commit -m "Scaffold Bun + ajv test harness for pipeline schemas"
```

---

## Task 2: Common schema definitions

**Files:**
- Create: `schemas/common.schema.json`
- Create: `tests/schemas/common.test.ts`

**Interfaces:**
- Consumes: nothing (base layer).
- Produces: `$defs` referenced by every later schema — exact pointer paths later tasks rely on:
  - `common.schema.json#/$defs/timestamp`
  - `common.schema.json#/$defs/url`
  - `common.schema.json#/$defs/hexColor`
  - `common.schema.json#/$defs/opaqueId`
  - `common.schema.json#/$defs/category` (enum: `visual | content | functional | integration`)
  - `common.schema.json#/$defs/severity` (enum: `blocker | major | minor`)
  - `common.schema.json#/$defs/sourcedFieldString`
  - `common.schema.json#/$defs/sourcedFieldNumber`
  - `common.schema.json#/$defs/sourcedFieldStringArray`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/schemas/common.test.ts
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("common.schema.json", () => {
  test("compiles standalone and exposes expected $defs", () => {
    const ajv = new Ajv({ strict: true });
    addFormats(ajv);
    const common = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "schemas", "common.schema.json"), "utf-8")
    );
    ajv.addSchema(common, "common.schema.json");

    for (const defName of [
      "timestamp", "url", "hexColor", "opaqueId",
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/schemas/common.test.ts`
Expected: FAIL — `ENOENT` reading `schemas/common.schema.json` (file doesn't exist yet).

- [ ] **Step 3: Write `schemas/common.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "common.schema.json",
  "$defs": {
    "timestamp": { "type": "string", "format": "date-time" },
    "url": { "type": "string", "format": "uri" },
    "hexColor": { "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$" },
    "opaqueId": { "type": "string", "minLength": 1 },
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/schemas/common.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add schemas/common.schema.json tests/schemas/common.test.ts
git commit -m "Add shared JSON Schema defs (envelope primitives, SourcedField, shared enums)"
```

---

## Task 3: pipeline-status.schema.json

**Files:**
- Create: `schemas/pipeline-status.schema.json`
- Create: `tests/schemas/fixtures/pipeline-status/valid.json`
- Create: `tests/schemas/fixtures/pipeline-status/invalid-bad-stage.json`
- Create: `tests/schemas/pipeline-status.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/timestamp` (Task 2).
- Produces: the 13-value `current_stage` enum (12 pipeline stages + `blocked_needs_human`) that later tasks' fixtures reference by name only (no other schema `$ref`s this file).

- [ ] **Step 1: Write fixtures**

```json
// tests/schemas/fixtures/pipeline-status/valid.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-03T14:22:00Z",
  "last_updated_by": "orchestrator",
  "data": {
    "current_stage": "qa_revision",
    "blocked": false,
    "blocked_reason": null,
    "mockup_revision_round": 1,
    "mockup_revision_cap": 3,
    "qa_revision_round": 2,
    "qa_revision_cap": 2,
    "stage_history": [
      { "stage": "kickoff", "entered_at": "2026-07-01T09:00:00Z", "exited_at": "2026-07-01T09:05:00Z", "agent": "human/intake" },
      { "stage": "scraping", "entered_at": "2026-07-01T09:05:00Z", "exited_at": "2026-07-01T09:20:00Z", "agent": "scraper" }
    ]
  }
}
```

```json
// tests/schemas/fixtures/pipeline-status/invalid-bad-stage.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-03T14:22:00Z",
  "last_updated_by": "orchestrator",
  "data": {
    "current_stage": "designing_stuff",
    "blocked": false,
    "blocked_reason": null,
    "mockup_revision_round": 1,
    "mockup_revision_cap": 3,
    "qa_revision_round": 2,
    "qa_revision_cap": 2,
    "stage_history": []
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/schemas/pipeline-status.test.ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("pipeline-status.schema.json", () => {
  const validate = () => compileSchema("pipeline-status.schema.json");

  test("accepts a valid pipeline-status.json", () => {
    const v = validate();
    expect(v(loadFixture("pipeline-status", "valid"))).toBe(true);
  });

  test("rejects an unrecognized current_stage", () => {
    const v = validate();
    expect(v(loadFixture("pipeline-status", "invalid-bad-stage"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/schemas/pipeline-status.test.ts`
Expected: FAIL — `schemas/pipeline-status.schema.json` doesn't exist.

- [ ] **Step 4: Write `schemas/pipeline-status.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "pipeline-status.schema.json",
  "title": "pipeline-status.json",
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
        "current_stage", "blocked", "blocked_reason",
        "mockup_revision_round", "mockup_revision_cap",
        "qa_revision_round", "qa_revision_cap", "stage_history"
      ],
      "properties": {
        "current_stage": {
          "enum": [
            "kickoff", "scraping", "design_homepage", "mockup_review", "mockup_revision",
            "design_locked", "design_remaining_pages", "backend_build", "qa", "qa_revision",
            "integration_signoff", "complete", "blocked_needs_human"
          ]
        },
        "blocked": { "type": "boolean" },
        "blocked_reason": { "type": ["string", "null"] },
        "mockup_revision_round": { "type": "integer", "minimum": 0 },
        "mockup_revision_cap": { "const": 3 },
        "qa_revision_round": { "type": "integer", "minimum": 0 },
        "qa_revision_cap": { "const": 2 },
        "stage_history": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["stage", "entered_at", "exited_at", "agent"],
            "properties": {
              "stage": { "type": "string" },
              "entered_at": { "$ref": "common.schema.json#/$defs/timestamp" },
              "exited_at": {
                "anyOf": [{ "$ref": "common.schema.json#/$defs/timestamp" }, { "type": "null" }]
              },
              "agent": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schemas/pipeline-status.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/pipeline-status.schema.json tests/schemas/fixtures/pipeline-status tests/schemas/pipeline-status.test.ts
git commit -m "Add pipeline-status.json schema"
```

---

## Task 4: kickoff.schema.json

**Files:**
- Create: `schemas/kickoff.schema.json`
- Create: `tests/schemas/fixtures/kickoff/valid.json`
- Create: `tests/schemas/fixtures/kickoff/invalid-ai-generated-real-subject.json`
- Create: `tests/schemas/kickoff.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/{url,hexColor,category}` (Task 2). Note `category` isn't used in kickoff.json itself but the shared enum values (`visual|content|functional|integration`) don't appear here at all — kickoff.json has no category field. (No `$ref` to `category` needed in this file; listed above only to confirm it's *not* consumed, so a later reviewer doesn't go looking for it.)
- Produces: nothing consumed by other schema files (kickoff.json is a leaf in the schema dependency graph — every agent reads it, but no other `.schema.json` `$ref`s into it).

- [ ] **Step 1: Write fixtures**

```json
// tests/schemas/fixtures/kickoff/valid.json
{
  "schema_version": "1.0",
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
      "locations": [{ "address": "123 Main St, Denver, CO", "phone": "+1-303-555-0100", "hours": "Mon-Fri 8am-6pm" }]
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

```json
// tests/schemas/fixtures/kickoff/invalid-ai-generated-real-subject.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-01T09:00:00Z",
  "last_updated_by": "human/intake",
  "data": {
    "primary_contact": { "name": "Jane Doe", "email": "jane@acme.co", "role": "Owner" },
    "languages": ["en"],
    "business": {
      "name": "Acme Co", "legal_name": null, "industry": "Home Services",
      "description": "Residential plumbing.", "founded_year": null,
      "existing_website_url": null, "social_profiles": [],
      "google_business_profile_url": null, "locations": []
    },
    "goals": { "primary_conversion_goal": "phone call booking", "secondary_goals": [] },
    "content_inventory": [
      {
        "page": "home", "sections": ["team-photo"],
        "text_source": "needs_writing", "media_source": "ai_generated",
        "represents_real_subject": true, "notes": "should be rejected: AI-generating a fake team photo"
      }
    ],
    "design_direction": {
      "style_words": [], "avoid": [], "reference_sites": [],
      "brand_assets": { "logo_url": null, "existing_colors": [], "existing_fonts": [] }
    },
    "functional_requirements": {
      "forms": [], "payments": { "required": false, "provider": null },
      "cms": { "required": false, "type": null }, "scheduling": { "required": false, "provider": null },
      "live_chat": { "required": false, "provider": null }, "newsletter": { "required": false, "provider": null },
      "integrations": []
    },
    "constraints": {
      "domain": null, "timeline_deadline": null, "budget_tier": "starter",
      "compliance": { "accessibility_level": "none", "privacy_regime": "none" }
    },
    "acceptance_criteria": []
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/schemas/kickoff.test.ts
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/schemas/kickoff.test.ts`
Expected: FAIL — `schemas/kickoff.schema.json` doesn't exist.

- [ ] **Step 4: Write `schemas/kickoff.schema.json`**

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
            "email": { "type": "string", "format": "email" },
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
                "required": ["address", "phone", "hours"],
                "properties": {
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

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schemas/kickoff.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/kickoff.schema.json tests/schemas/fixtures/kickoff tests/schemas/kickoff.test.ts
git commit -m "Add kickoff.json schema with AI-imagery real-subject constraint"
```

---

## Task 5: scraper-output.schema.json

**Files:**
- Create: `schemas/scraper-output.schema.json`
- Create: `tests/schemas/fixtures/scraper-output/valid.json`
- Create: `tests/schemas/fixtures/scraper-output/invalid-missing-confidence.json`
- Create: `tests/schemas/scraper-output.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/{sourcedFieldString,sourcedFieldNumber,sourcedFieldStringArray,url}` (Task 2).
- Produces: nothing consumed by other schema files. Note for the scraper-agent work that comes after this plan: the `reviews.live_display` shape here is the *persisted* contract; the `PlacesReviewSample` shape (`author_photo_url`, `author_profile_url`, live-fetched review text/rating) is deliberately **not** part of this schema — it's a runtime/backend-agent contract documented in `docs/spec.md` prose only, per the Places API ToS compliance note in the design doc.

- [ ] **Step 1: Write fixtures**

```json
// tests/schemas/fixtures/scraper-output/valid.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-01T10:00:00Z",
  "last_updated_by": "scraper-agent",
  "data": {
    "scrape_mode": "own_site",
    "completeness": "good",
    "business_info": {
      "name": { "value": "Acme Plumbing", "source": "own_site", "confidence": "verified" },
      "address": { "value": "123 Main St, Denver, CO", "source": "own_site", "confidence": "verified" },
      "phone": { "value": "+1-303-555-0100", "source": "own_site", "confidence": "verified" },
      "hours": { "value": "Mon-Fri 8am-6pm", "source": "own_site", "confidence": "verified" },
      "categories": { "value": ["Plumber", "Emergency Service"], "source": "own_site", "confidence": "verified" },
      "price_level": { "value": null, "source": "not_found", "confidence": "missing" }
    },
    "reviews": {
      "aggregate_rating": { "value": 4.8, "source": "places_api", "confidence": "verified" },
      "review_count": { "value": 152, "source": "places_api", "confidence": "verified" },
      "places_place_id": { "value": "ChIJabc123", "source": "places_api", "confidence": "verified" },
      "live_display": {
        "mode": "live_fetch", "max_results": 6, "sort": "highest_rated",
        "note": "Places-sourced review text/ratings/author photos must be fetched live at render/request time by the backend agent's implementation. Only place_id is persisted here."
      },
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

```json
// tests/schemas/fixtures/scraper-output/invalid-missing-confidence.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-01T10:00:00Z",
  "last_updated_by": "scraper-agent",
  "data": {
    "scrape_mode": "own_site",
    "completeness": "good",
    "business_info": {
      "name": { "value": "Acme Plumbing", "source": "own_site" },
      "address": { "value": "123 Main St, Denver, CO", "source": "own_site", "confidence": "verified" },
      "phone": { "value": "+1-303-555-0100", "source": "own_site", "confidence": "verified" },
      "hours": { "value": "Mon-Fri 8am-6pm", "source": "own_site", "confidence": "verified" },
      "categories": { "value": ["Plumber"], "source": "own_site", "confidence": "verified" },
      "price_level": { "value": null, "source": "not_found", "confidence": "missing" }
    },
    "reviews": {
      "aggregate_rating": { "value": 4.8, "source": "places_api", "confidence": "verified" },
      "review_count": { "value": 152, "source": "places_api", "confidence": "verified" },
      "places_place_id": { "value": "ChIJabc123", "source": "places_api", "confidence": "verified" },
      "live_display": { "mode": "live_fetch", "max_results": 6, "sort": "highest_rated", "note": "n/a" },
      "own_site_testimonials": []
    },
    "content_found": [],
    "social_profiles_found": [],
    "scrape_notes": []
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/schemas/scraper-output.test.ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("scraper-output.schema.json", () => {
  const validate = () => compileSchema("scraper-output.schema.json");

  test("accepts a valid scraper-output.json", () => {
    const v = validate();
    expect(v(loadFixture("scraper-output", "valid"))).toBe(true);
  });

  test("rejects a SourcedField missing 'confidence'", () => {
    const v = validate();
    expect(v(loadFixture("scraper-output", "invalid-missing-confidence"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/schemas/scraper-output.test.ts`
Expected: FAIL — `schemas/scraper-output.schema.json` doesn't exist.

- [ ] **Step 4: Write `schemas/scraper-output.schema.json`**

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
          "required": ["name", "address", "phone", "hours", "categories", "price_level"],
          "properties": {
            "name": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
            "address": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
            "phone": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
            "hours": { "$ref": "common.schema.json#/$defs/sourcedFieldString" },
            "categories": { "$ref": "common.schema.json#/$defs/sourcedFieldStringArray" },
            "price_level": { "$ref": "common.schema.json#/$defs/sourcedFieldString" }
          }
        },
        "reviews": {
          "type": "object", "additionalProperties": false,
          "required": ["aggregate_rating", "review_count", "places_place_id", "live_display", "own_site_testimonials"],
          "properties": {
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

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schemas/scraper-output.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/scraper-output.schema.json tests/schemas/fixtures/scraper-output tests/schemas/scraper-output.test.ts
git commit -m "Add scraper-output.json schema"
```

---

## Task 6: design-lock.schema.json

**Files:**
- Create: `schemas/design-lock.schema.json`
- Create: `tests/schemas/fixtures/design-lock/valid.json`
- Create: `tests/schemas/fixtures/design-lock/invalid-bad-hex.json`
- Create: `tests/schemas/design-lock.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/{hexColor,timestamp}` (Task 2).
- Produces: nothing consumed by other schema files.

- [ ] **Step 1: Write fixtures**

```json
// tests/schemas/fixtures/design-lock/valid.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-02T11:00:00Z",
  "last_updated_by": "design-agent",
  "data": {
    "tokens": {
      "colors": {
        "primary": "#1A73E8", "secondary": "#34A853", "accent": "#FBBC05",
        "background": "#FFFFFF", "surface": "#F5F5F5",
        "text_primary": "#202124", "text_secondary": "#5F6368",
        "text_on_primary": "#FFFFFF", "text_on_secondary": "#FFFFFF",
        "border": "#DADCE0", "success": "#188038", "warning": "#F29900", "error": "#D93025"
      },
      "typography": {
        "heading_font": "Inter", "body_font": "Inter",
        "scale": { "h1": "48px", "h2": "36px", "h3": "24px", "body": "16px", "small": "14px" }
      },
      "spacing_scale": ["4px", "8px", "16px", "24px", "32px"],
      "radius": "8px", "shadow_style": "soft", "imagery_style": "photographic",
      "breakpoints": { "mobile": "375px", "tablet": "768px", "desktop": "1280px" }
    },
    "component_catalog": [
      {
        "pattern": "hero-with-cta", "library": "shadcn", "component_name": "HeroSection",
        "file_path": "src/components/hero-section.tsx", "variant_notes": null,
        "added_at": "2026-07-02T11:00:00Z", "added_during": "homepage"
      }
    ],
    "approved_homepage_mockup_ref": "mockup/screenshots/round-2/homepage.png",
    "approved_mockup_revision_round": 2,
    "generated_assets": [
      {
        "file_path": "public/images/hero-bg.png",
        "prompt": "abstract soft-gradient background, blue and green, no text",
        "model": "nano_banana_flash", "cost_usd": 0.02, "generated_at": "2026-07-02T10:55:00Z"
      }
    ]
  }
}
```

```json
// tests/schemas/fixtures/design-lock/invalid-bad-hex.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-02T11:00:00Z",
  "last_updated_by": "design-agent",
  "data": {
    "tokens": {
      "colors": {
        "primary": "blue", "secondary": "#34A853", "accent": "#FBBC05",
        "background": "#FFFFFF", "surface": "#F5F5F5",
        "text_primary": "#202124", "text_secondary": "#5F6368",
        "text_on_primary": "#FFFFFF", "text_on_secondary": "#FFFFFF",
        "border": "#DADCE0", "success": "#188038", "warning": "#F29900", "error": "#D93025"
      },
      "typography": { "heading_font": "Inter", "body_font": "Inter", "scale": { "h1": "48px", "h2": "36px", "h3": "24px", "body": "16px", "small": "14px" } },
      "spacing_scale": [], "radius": "8px", "shadow_style": "soft", "imagery_style": "photographic",
      "breakpoints": { "mobile": "375px", "tablet": "768px", "desktop": "1280px" }
    },
    "component_catalog": [],
    "approved_homepage_mockup_ref": "mockup/screenshots/round-1/homepage.png",
    "approved_mockup_revision_round": 1,
    "generated_assets": []
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/schemas/design-lock.test.ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("design-lock.schema.json", () => {
  const validate = () => compileSchema("design-lock.schema.json");

  test("accepts a valid design-lock.json", () => {
    const v = validate();
    expect(v(loadFixture("design-lock", "valid"))).toBe(true);
  });

  test("rejects a non-hex color token", () => {
    const v = validate();
    expect(v(loadFixture("design-lock", "invalid-bad-hex"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/schemas/design-lock.test.ts`
Expected: FAIL — `schemas/design-lock.schema.json` doesn't exist.

- [ ] **Step 4: Write `schemas/design-lock.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "design-lock.schema.json",
  "title": "design-lock.json",
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
      "required": ["tokens", "component_catalog", "approved_homepage_mockup_ref", "approved_mockup_revision_round", "generated_assets"],
      "properties": {
        "tokens": {
          "type": "object", "additionalProperties": false,
          "required": ["colors", "typography", "spacing_scale", "radius", "shadow_style", "imagery_style", "breakpoints"],
          "properties": {
            "colors": {
              "type": "object", "additionalProperties": false,
              "required": [
                "primary", "secondary", "accent", "background", "surface",
                "text_primary", "text_secondary", "text_on_primary", "text_on_secondary",
                "border", "success", "warning", "error"
              ],
              "properties": {
                "primary": { "$ref": "common.schema.json#/$defs/hexColor" },
                "secondary": { "$ref": "common.schema.json#/$defs/hexColor" },
                "accent": { "$ref": "common.schema.json#/$defs/hexColor" },
                "background": { "$ref": "common.schema.json#/$defs/hexColor" },
                "surface": { "$ref": "common.schema.json#/$defs/hexColor" },
                "text_primary": { "$ref": "common.schema.json#/$defs/hexColor" },
                "text_secondary": { "$ref": "common.schema.json#/$defs/hexColor" },
                "text_on_primary": { "$ref": "common.schema.json#/$defs/hexColor" },
                "text_on_secondary": { "$ref": "common.schema.json#/$defs/hexColor" },
                "border": { "$ref": "common.schema.json#/$defs/hexColor" },
                "success": { "$ref": "common.schema.json#/$defs/hexColor" },
                "warning": { "$ref": "common.schema.json#/$defs/hexColor" },
                "error": { "$ref": "common.schema.json#/$defs/hexColor" }
              }
            },
            "typography": {
              "type": "object", "additionalProperties": false,
              "required": ["heading_font", "body_font", "scale"],
              "properties": {
                "heading_font": { "type": "string" },
                "body_font": { "type": "string" },
                "scale": {
                  "type": "object", "additionalProperties": false,
                  "required": ["h1", "h2", "h3", "body", "small"],
                  "properties": {
                    "h1": { "type": "string" }, "h2": { "type": "string" }, "h3": { "type": "string" },
                    "body": { "type": "string" }, "small": { "type": "string" }
                  }
                }
              }
            },
            "spacing_scale": { "type": "array", "items": { "type": "string" } },
            "radius": { "type": "string" },
            "shadow_style": { "type": "string" },
            "imagery_style": { "type": "string" },
            "breakpoints": {
              "type": "object", "additionalProperties": false,
              "required": ["mobile", "tablet", "desktop"],
              "properties": {
                "mobile": { "type": "string", "pattern": "^[0-9]+px$" },
                "tablet": { "type": "string", "pattern": "^[0-9]+px$" },
                "desktop": { "type": "string", "pattern": "^[0-9]+px$" }
              }
            }
          }
        },
        "component_catalog": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["pattern", "library", "component_name", "file_path", "variant_notes", "added_at", "added_during"],
            "properties": {
              "pattern": { "type": "string" },
              "library": { "enum": ["shadcn", "reactbits"] },
              "component_name": { "type": "string" },
              "file_path": { "type": "string" },
              "variant_notes": { "type": ["string", "null"] },
              "added_at": { "$ref": "common.schema.json#/$defs/timestamp" },
              "added_during": { "enum": ["homepage", "remaining_pages"] }
            }
          }
        },
        "approved_homepage_mockup_ref": { "type": "string" },
        "approved_mockup_revision_round": { "type": "integer", "minimum": 1 },
        "generated_assets": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["file_path", "prompt", "model", "cost_usd", "generated_at"],
            "properties": {
              "file_path": { "type": "string" },
              "prompt": { "type": "string" },
              "model": { "enum": ["nano_banana_flash", "nano_banana_pro"] },
              "cost_usd": { "type": "number", "minimum": 0 },
              "generated_at": { "$ref": "common.schema.json#/$defs/timestamp" }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schemas/design-lock.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/design-lock.schema.json tests/schemas/fixtures/design-lock tests/schemas/design-lock.test.ts
git commit -m "Add design-lock.json schema"
```

---

## Task 7: mockup-approval.schema.json

**Files:**
- Create: `schemas/mockup-approval.schema.json`
- Create: `tests/schemas/fixtures/mockup-approval/valid.json`
- Create: `tests/schemas/fixtures/mockup-approval/invalid-bad-category.json`
- Create: `tests/schemas/mockup-approval.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/{timestamp,category}` (Task 2).
- Produces: nothing consumed by other schema files.

- [ ] **Step 1: Write fixtures**

```json
// tests/schemas/fixtures/mockup-approval/valid.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-02T15:00:00Z",
  "last_updated_by": "orchestrator",
  "data": {
    "status": "changes_requested",
    "current_round": 1,
    "rounds": [
      {
        "round": 1, "mockup_ref": "mockup/screenshots/round-1/homepage.png", "submitted_at": "2026-07-02T14:00:00Z",
        "feedback_items": [
          {
            "id": "fb-1", "page": "home", "element": "hero headline",
            "screenshot_ref": "mockup/screenshots/round-1/homepage.png",
            "annotation_coords": { "x": 100, "y": 50, "width": 300, "height": 40 },
            "requested_change": "Make the headline shorter", "category": "visual",
            "deferred_to_stage": null, "status": "open", "agent_note": null
          },
          {
            "id": "fb-2", "page": "home", "element": "booking widget",
            "screenshot_ref": "mockup/screenshots/round-1/homepage.png",
            "annotation_coords": null,
            "requested_change": "Wire this up to Calendly", "category": "functional",
            "deferred_to_stage": "backend_build", "status": "open", "agent_note": null
          }
        ],
        "decided_at": "2026-07-02T15:00:00Z", "decided_status": "changes_requested"
      }
    ]
  }
}
```

```json
// tests/schemas/fixtures/mockup-approval/invalid-bad-category.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-02T15:00:00Z",
  "last_updated_by": "orchestrator",
  "data": {
    "status": "changes_requested",
    "current_round": 1,
    "rounds": [
      {
        "round": 1, "mockup_ref": "mockup/screenshots/round-1/homepage.png", "submitted_at": "2026-07-02T14:00:00Z",
        "feedback_items": [
          {
            "id": "fb-1", "page": "home", "element": "hero headline",
            "screenshot_ref": "mockup/screenshots/round-1/homepage.png", "annotation_coords": null,
            "requested_change": "Make the headline shorter", "category": "aesthetic",
            "deferred_to_stage": null, "status": "open", "agent_note": null
          }
        ],
        "decided_at": null, "decided_status": null
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/schemas/mockup-approval.test.ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("mockup-approval.schema.json", () => {
  const validate = () => compileSchema("mockup-approval.schema.json");

  test("accepts a valid mockup-approval.json", () => {
    const v = validate();
    expect(v(loadFixture("mockup-approval", "valid"))).toBe(true);
  });

  test("rejects an unrecognized feedback category", () => {
    const v = validate();
    expect(v(loadFixture("mockup-approval", "invalid-bad-category"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/schemas/mockup-approval.test.ts`
Expected: FAIL — `schemas/mockup-approval.schema.json` doesn't exist.

- [ ] **Step 4: Write `schemas/mockup-approval.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "mockup-approval.schema.json",
  "title": "mockup-approval.json",
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
      "required": ["status", "current_round", "rounds"],
      "properties": {
        "status": { "enum": ["pending", "changes_requested", "approved"] },
        "current_round": { "type": "integer", "minimum": 1 },
        "rounds": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["round", "mockup_ref", "submitted_at", "feedback_items", "decided_at", "decided_status"],
            "properties": {
              "round": { "type": "integer", "minimum": 1 },
              "mockup_ref": { "type": "string" },
              "submitted_at": { "$ref": "common.schema.json#/$defs/timestamp" },
              "feedback_items": {
                "type": "array",
                "items": {
                  "type": "object", "additionalProperties": false,
                  "required": ["id", "page", "element", "screenshot_ref", "annotation_coords", "requested_change", "category", "deferred_to_stage", "status", "agent_note"],
                  "properties": {
                    "id": { "$ref": "common.schema.json#/$defs/opaqueId" },
                    "page": { "type": "string" },
                    "element": { "type": "string" },
                    "screenshot_ref": { "type": "string" },
                    "annotation_coords": {
                      "anyOf": [
                        {
                          "type": "object", "additionalProperties": false,
                          "required": ["x", "y", "width", "height"],
                          "properties": {
                            "x": { "type": "number" }, "y": { "type": "number" },
                            "width": { "type": "number" }, "height": { "type": "number" }
                          }
                        },
                        { "type": "null" }
                      ]
                    },
                    "requested_change": { "type": "string" },
                    "category": { "$ref": "common.schema.json#/$defs/category" },
                    "deferred_to_stage": { "type": ["string", "null"] },
                    "status": { "enum": ["open", "addressed", "wont_fix"] },
                    "agent_note": { "type": ["string", "null"] }
                  }
                }
              },
              "decided_at": { "anyOf": [{ "$ref": "common.schema.json#/$defs/timestamp" }, { "type": "null" }] },
              "decided_status": { "anyOf": [{ "enum": ["changes_requested", "approved"] }, { "type": "null" }] }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schemas/mockup-approval.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/mockup-approval.schema.json tests/schemas/fixtures/mockup-approval tests/schemas/mockup-approval.test.ts
git commit -m "Add mockup-approval.json schema"
```

---

## Task 8: qa-report.schema.json

**Files:**
- Create: `schemas/qa-report.schema.json`
- Create: `tests/schemas/fixtures/qa-report/valid.json`
- Create: `tests/schemas/fixtures/qa-report/invalid-bad-status.json`
- Create: `tests/schemas/qa-report.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/{timestamp,category,severity}` (Task 2).
- Produces: nothing consumed by other schema files. **Reminder from Global Constraints:** this schema validates shape only — `overall_status`/`round_result`/`pass_condition` correctness is not and cannot be a JSON Schema constraint; it's an orchestrator-side computation documented in `docs/spec.md`.

- [ ] **Step 1: Write fixtures**

```json
// tests/schemas/fixtures/qa-report/valid.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-03T09:00:00Z",
  "last_updated_by": "qa-agent",
  "data": {
    "overall_status": "fail",
    "current_round": 1,
    "rounds": [
      {
        "round": 1, "scope": "full", "tested_at": "2026-07-03T09:00:00Z",
        "findings": [
          {
            "id": "qa-1", "reopened_from_id": null,
            "page": "home", "issue": "Contact form doesn't submit", "severity": "blocker",
            "category": "functional", "screenshot_ref": null,
            "status": "open", "agent_note": null
          }
        ],
        "acceptance_criteria_check": [
          { "criterion": "Contact form delivers to leads@acme.co", "verification_method": "submit test form, confirm email receipt", "verified": false, "note": "form submit is broken" }
        ],
        "round_result": "fail"
      }
    ]
  }
}
```

```json
// tests/schemas/fixtures/qa-report/invalid-bad-status.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-03T09:00:00Z",
  "last_updated_by": "qa-agent",
  "data": {
    "overall_status": "fail",
    "current_round": 1,
    "rounds": [
      {
        "round": 1, "scope": "full", "tested_at": "2026-07-03T09:00:00Z",
        "findings": [
          {
            "id": "qa-1", "reopened_from_id": null,
            "page": "home", "issue": "Contact form doesn't submit", "severity": "blocker",
            "category": "functional", "screenshot_ref": null,
            "status": "in_progress", "agent_note": null
          }
        ],
        "acceptance_criteria_check": [],
        "round_result": "fail"
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/schemas/qa-report.test.ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("qa-report.schema.json", () => {
  const validate = () => compileSchema("qa-report.schema.json");

  test("accepts a valid qa-report.json", () => {
    const v = validate();
    expect(v(loadFixture("qa-report", "valid"))).toBe(true);
  });

  test("rejects an unrecognized finding status", () => {
    const v = validate();
    expect(v(loadFixture("qa-report", "invalid-bad-status"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/schemas/qa-report.test.ts`
Expected: FAIL — `schemas/qa-report.schema.json` doesn't exist.

- [ ] **Step 4: Write `schemas/qa-report.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "qa-report.schema.json",
  "title": "qa-report.json",
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
      "required": ["overall_status", "current_round", "rounds"],
      "properties": {
        "overall_status": { "enum": ["pass", "fail"] },
        "current_round": { "type": "integer", "minimum": 1 },
        "rounds": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["round", "scope", "tested_at", "findings", "acceptance_criteria_check", "round_result"],
            "properties": {
              "round": { "type": "integer", "minimum": 1 },
              "scope": { "const": "full" },
              "tested_at": { "$ref": "common.schema.json#/$defs/timestamp" },
              "findings": {
                "type": "array",
                "items": {
                  "type": "object", "additionalProperties": false,
                  "required": ["id", "reopened_from_id", "page", "issue", "severity", "category", "screenshot_ref", "status", "agent_note"],
                  "properties": {
                    "id": { "$ref": "common.schema.json#/$defs/opaqueId" },
                    "reopened_from_id": { "anyOf": [{ "$ref": "common.schema.json#/$defs/opaqueId" }, { "type": "null" }] },
                    "page": { "type": "string" },
                    "issue": { "type": "string" },
                    "severity": { "$ref": "common.schema.json#/$defs/severity" },
                    "category": { "$ref": "common.schema.json#/$defs/category" },
                    "screenshot_ref": { "type": ["string", "null"] },
                    "status": { "enum": ["open", "fixed_claimed", "disputed", "verified_fixed", "wont_fix", "superseded"] },
                    "agent_note": { "type": ["string", "null"] }
                  }
                }
              },
              "acceptance_criteria_check": {
                "type": "array",
                "items": {
                  "type": "object", "additionalProperties": false,
                  "required": ["criterion", "verification_method", "verified", "note"],
                  "properties": {
                    "criterion": { "type": "string" },
                    "verification_method": { "type": "string" },
                    "verified": { "type": "boolean" },
                    "note": { "type": ["string", "null"] }
                  }
                }
              },
              "round_result": { "enum": ["pass", "fail"] }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schemas/qa-report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/qa-report.schema.json tests/schemas/fixtures/qa-report tests/schemas/qa-report.test.ts
git commit -m "Add qa-report.json schema"
```

---

## Task 9: signoff.schema.json

**Files:**
- Create: `schemas/signoff.schema.json`
- Create: `tests/schemas/fixtures/signoff/valid.json`
- Create: `tests/schemas/fixtures/signoff/invalid-bad-decision.json`
- Create: `tests/schemas/signoff.test.ts`

**Interfaces:**
- Consumes: `common.schema.json#/$defs/{timestamp,category,url}` (Task 2).
- Produces: nothing consumed by other schema files.

- [ ] **Step 1: Write fixtures**

```json
// tests/schemas/fixtures/signoff/valid.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-03T16:00:00Z",
  "last_updated_by": "integration-lead-agent",
  "data": {
    "current_round": 1,
    "review_rounds": [
      {
        "round": 1, "reviewed_at": "2026-07-03T16:00:00Z",
        "checklist": { "repo_pushed": true, "preview_deploy_live": true, "dns_domain_configured": "n/a", "env_vars_configured": true },
        "unresolved_majors": [
          {
            "qa_finding_id": "qa-7", "page": "about", "issue": "Team photo slightly misaligned on mobile",
            "category": "visual", "decision": "ship_anyway", "decision_note": "Cosmetic, client agreed to fix post-launch."
          }
        ],
        "client_final_approval": {
          "status": "approved", "approved_at": "2026-07-03T16:30:00Z", "approved_by": "Jane Doe", "notes": "Looks great!",
          "requested_changes": []
        },
        "round_outcome": "promoted"
      }
    ],
    "repo_url": "https://github.com/acme-builder/acme-co-site",
    "preview_deploy_url": "https://acme-co-site-preview.vercel.app",
    "production_url": "https://acmeplumbing.com",
    "production_promotion_status": "promoted"
  }
}
```

```json
// tests/schemas/fixtures/signoff/invalid-bad-decision.json
{
  "schema_version": "1.0",
  "client_id": "acme-co",
  "last_updated_at": "2026-07-03T16:00:00Z",
  "last_updated_by": "integration-lead-agent",
  "data": {
    "current_round": 1,
    "review_rounds": [
      {
        "round": 1, "reviewed_at": "2026-07-03T16:00:00Z",
        "checklist": { "repo_pushed": true, "preview_deploy_live": true, "dns_domain_configured": "n/a", "env_vars_configured": true },
        "unresolved_majors": [
          {
            "qa_finding_id": "qa-7", "page": "about", "issue": "Team photo slightly misaligned on mobile",
            "category": "visual", "decision": "maybe_later", "decision_note": null
          }
        ],
        "client_final_approval": { "status": "pending", "approved_at": null, "approved_by": null, "notes": null, "requested_changes": [] },
        "round_outcome": "pending"
      }
    ],
    "repo_url": "https://github.com/acme-builder/acme-co-site",
    "preview_deploy_url": "https://acme-co-site-preview.vercel.app",
    "production_url": null,
    "production_promotion_status": "not_promoted"
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/schemas/signoff.test.ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("signoff.schema.json", () => {
  const validate = () => compileSchema("signoff.schema.json");

  test("accepts a valid signoff.json", () => {
    const v = validate();
    expect(v(loadFixture("signoff", "valid"))).toBe(true);
  });

  test("rejects an unrecognized unresolved_majors decision", () => {
    const v = validate();
    expect(v(loadFixture("signoff", "invalid-bad-decision"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/schemas/signoff.test.ts`
Expected: FAIL — `schemas/signoff.schema.json` doesn't exist.

- [ ] **Step 4: Write `schemas/signoff.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "signoff.schema.json",
  "title": "signoff.json",
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
      "required": ["current_round", "review_rounds", "repo_url", "preview_deploy_url", "production_url", "production_promotion_status"],
      "properties": {
        "current_round": { "type": "integer", "minimum": 1 },
        "review_rounds": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["round", "reviewed_at", "checklist", "unresolved_majors", "client_final_approval", "round_outcome"],
            "properties": {
              "round": { "type": "integer", "minimum": 1 },
              "reviewed_at": { "$ref": "common.schema.json#/$defs/timestamp" },
              "checklist": {
                "type": "object", "additionalProperties": false,
                "required": ["repo_pushed", "preview_deploy_live", "dns_domain_configured", "env_vars_configured"],
                "properties": {
                  "repo_pushed": { "type": "boolean" },
                  "preview_deploy_live": { "type": "boolean" },
                  "dns_domain_configured": { "anyOf": [{ "type": "boolean" }, { "const": "n/a" }] },
                  "env_vars_configured": { "type": "boolean" }
                }
              },
              "unresolved_majors": {
                "type": "array",
                "items": {
                  "type": "object", "additionalProperties": false,
                  "required": ["qa_finding_id", "page", "issue", "category", "decision", "decision_note"],
                  "properties": {
                    "qa_finding_id": { "$ref": "common.schema.json#/$defs/opaqueId" },
                    "page": { "type": "string" },
                    "issue": { "type": "string" },
                    "category": { "$ref": "common.schema.json#/$defs/category" },
                    "decision": { "enum": ["ship_anyway", "kick_back_to_qa"] },
                    "decision_note": { "type": ["string", "null"] }
                  }
                }
              },
              "client_final_approval": {
                "type": "object", "additionalProperties": false,
                "required": ["status", "approved_at", "approved_by", "notes", "requested_changes"],
                "properties": {
                  "status": { "enum": ["pending", "approved", "changes_requested"] },
                  "approved_at": { "anyOf": [{ "$ref": "common.schema.json#/$defs/timestamp" }, { "type": "null" }] },
                  "approved_by": { "type": ["string", "null"] },
                  "notes": { "type": ["string", "null"] },
                  "requested_changes": {
                    "type": "array",
                    "items": {
                      "type": "object", "additionalProperties": false,
                      "required": ["page", "issue", "category", "client_flagged_blocking"],
                      "properties": {
                        "page": { "type": "string" },
                        "issue": { "type": "string" },
                        "category": { "$ref": "common.schema.json#/$defs/category" },
                        "client_flagged_blocking": { "type": "boolean" }
                      }
                    }
                  }
                }
              },
              "round_outcome": { "enum": ["promoted", "returned_to_qa", "pending"] }
            }
          }
        },
        "repo_url": { "$ref": "common.schema.json#/$defs/url" },
        "preview_deploy_url": { "$ref": "common.schema.json#/$defs/url" },
        "production_url": { "anyOf": [{ "$ref": "common.schema.json#/$defs/url" }, { "type": "null" }] },
        "production_promotion_status": { "enum": ["not_promoted", "promoted"] }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/schemas/signoff.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add schemas/signoff.schema.json tests/schemas/fixtures/signoff tests/schemas/signoff.test.ts
git commit -m "Add signoff.json schema"
```

---

## Task 10: docs/spec.md + full-pipeline integration test + self-review

**Files:**
- Create: `docs/spec.md`
- Create: `tests/schemas/full-pipeline.test.ts`

**Interfaces:**
- Consumes: all 7 schemas (Tasks 3–9) and all fixture `valid.json` files.
- Produces: the final human-facing reference document; nothing further downstream in this plan.

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/schemas/full-pipeline.test.ts
import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("full pipeline — every file's valid fixture validates against its own schema", () => {
  const files: Array<[string, string]> = [
    ["pipeline-status.schema.json", "pipeline-status"],
    ["kickoff.schema.json", "kickoff"],
    ["scraper-output.schema.json", "scraper-output"],
    ["design-lock.schema.json", "design-lock"],
    ["mockup-approval.schema.json", "mockup-approval"],
    ["qa-report.schema.json", "qa-report"],
    ["signoff.schema.json", "signoff"],
  ];

  for (const [schemaFile, fixtureDir] of files) {
    test(`${fixtureDir}/valid.json validates against ${schemaFile}`, () => {
      const validate = compileSchema(schemaFile);
      const fixture = loadFixture(fixtureDir, "valid");
      const ok = validate(fixture);
      if (!ok) {
        throw new Error(`${fixtureDir}/valid.json failed: ${JSON.stringify(validate.errors, null, 2)}`);
      }
      expect(ok).toBe(true);
    });
  }

  test("client_id is consistent across every file's valid fixture (same fake client, acme-co)", () => {
    for (const [, fixtureDir] of files) {
      const fixture = loadFixture(fixtureDir, "valid") as { client_id: string };
      expect(fixture.client_id).toBe("acme-co");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/schemas/full-pipeline.test.ts`
Expected: PASS actually — by this point in the plan all 7 schemas and fixtures already exist from Tasks 3–9, so this is a regression/integration check, not new-feature TDD. Run it anyway and confirm it's green before moving on; if anything fails here, a prior task's schema/fixture pair has drifted and must be fixed before writing `docs/spec.md` (which describes these exact fixtures' shape).

- [ ] **Step 3: Write `docs/spec.md`**

```markdown
# Client Pipeline State Schema — Reference

Source design: `docs/superpowers/specs/2026-07-03-client-pipeline-state-schema-design.md`
Machine-checkable schemas: `schemas/*.schema.json` (draft-07, validated with `ajv` — see `tests/schemas/`)

This document is the field-by-field reference for every file in a client's `.pipeline/` directory: what each field means, who writes it, and who reads it. If this document and a `.schema.json` file ever disagree on *shape*, the schema is authoritative (it's machine-checked); if either disagrees with the design doc on *intent*, the design doc is authoritative and this file has drifted and needs fixing.

## Shared envelope

Every file wraps its content identically:

| Field | Meaning | Written by |
|---|---|---|
| `schema_version` | Schema version this file conforms to (currently `"1.0"`). | Whoever last wrote the file. |
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
| `business.locations` | One or more physical locations; each an `{address, phone, hours}` triple. |
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
| `business_info.*` | Core facts (name, address, phone, hours, categories, price level), each a `SourcedField`. |
| `reviews.aggregate_rating` / `review_count` | Summary stats, `SourcedField<number>`. |
| `reviews.places_place_id` | The **only** Places-sourced review data persisted here. Permitted indefinitely under Places API ToS. |
| `reviews.live_display` | Instructions for the backend agent's *implementation*, not stored review content: `mode` (`live_fetch \| none`), `max_results`, `sort` (`most_recent \| highest_rated`). Review text, ratings, and author photos must be fetched live at render/request time — never baked into this file. See the compliance note below for the `PlacesReviewSample` shape the backend agent's live-fetch code should use. |
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
| `tokens.typography.*` | Font choices and the `h1`–`small` size scale. |
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
```

- [ ] **Step 4: Run the full test suite to verify everything passes together**

Run: `bun test`
Expected: PASS — all tests across `common.test.ts` (2), `pipeline-status.test.ts` (2), `kickoff.test.ts` (2), `scraper-output.test.ts` (2), `design-lock.test.ts` (2), `mockup-approval.test.ts` (2), `qa-report.test.ts` (2), `signoff.test.ts` (2), and `full-pipeline.test.ts` (8: 7 per-file validity checks + 1 client_id consistency check) — 24 tests total.

- [ ] **Step 5: Self-review against the design doc**

Read `docs/superpowers/specs/2026-07-03-client-pipeline-state-schema-design.md` section by section and confirm every field mentioned there has a corresponding line in `docs/spec.md` and a corresponding property in the matching `.schema.json`. Specifically check: the AI-imagery `not` constraint in `kickoff.schema.json`, `generated_assets` append-only note, `reuse_safe` on both `content_found` items and `content_found[].images[]`, `dns_domain_configured`'s `boolean | "n/a"` union, the `pass_condition` dual-scope note, and the `client_final_approval` write-ownership carve-out. Fix any gap found directly — no need to re-review after.

- [ ] **Step 6: Commit**

```bash
git add docs/spec.md tests/schemas/full-pipeline.test.ts
git commit -m "Add docs/spec.md and full-pipeline integration test"
```

---

## Execution Handoff

Once this plan is approved, two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Requires `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.
