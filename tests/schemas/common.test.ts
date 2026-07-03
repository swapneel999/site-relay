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
