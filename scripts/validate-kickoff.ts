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
