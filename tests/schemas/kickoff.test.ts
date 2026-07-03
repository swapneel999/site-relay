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
