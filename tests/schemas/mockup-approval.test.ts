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
