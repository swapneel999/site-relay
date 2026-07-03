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
