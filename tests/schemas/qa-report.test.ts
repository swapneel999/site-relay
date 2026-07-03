import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("qa-report.schema.json", () => {
  const validate = () => compileSchema("qa-report.schema.json");

  test("accepts a valid qa-report.json", () => {
    const v = validate();
    expect(v(loadFixture("qa-report", "valid"))).toBe(true);
  });

  test("rejects an unrecognized finding status", () => {
    const v = validate();
    expect(v(loadFixture("qa-report", "invalid-bad-status"))).toBe(false);
  });
});
