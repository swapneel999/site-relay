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
