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
