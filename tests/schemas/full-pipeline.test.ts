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
