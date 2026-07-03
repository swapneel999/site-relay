import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("pipeline-status.schema.json", () => {
  const validate = () => compileSchema("pipeline-status.schema.json");

  test("accepts a valid pipeline-status.json", () => {
    const v = validate();
    expect(v(loadFixture("pipeline-status", "valid"))).toBe(true);
  });

  test("rejects an unrecognized current_stage", () => {
    const v = validate();
    expect(v(loadFixture("pipeline-status", "invalid-bad-stage"))).toBe(false);
  });
});
