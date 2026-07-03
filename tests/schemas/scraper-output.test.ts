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
