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
