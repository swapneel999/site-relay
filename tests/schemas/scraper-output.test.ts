import { describe, expect, test } from "bun:test";
import { compileSchema, loadFixture } from "./helpers";

describe("scraper-output.schema.json", () => {
  const validate = () => compileSchema("scraper-output.schema.json");

  test("accepts a valid single-location scraper-output.json", () => {
    const v = validate();
    expect(v(loadFixture("scraper-output", "valid"))).toBe(true);
  });

  test("rejects a SourcedField missing 'confidence'", () => {
    const v = validate();
    expect(v(loadFixture("scraper-output", "invalid-missing-confidence"))).toBe(false);
  });

  test("accepts a valid multi-location scraper-output.json (business_info.locations[] and reviews.by_location[] each with 2 entries)", () => {
    const v = validate();
    const fixture = loadFixture("scraper-output", "valid-multi-location") as any;
    expect(fixture.data.business_info.locations.length).toBe(2);
    expect(fixture.data.reviews.by_location.length).toBe(2);
    expect(v(fixture)).toBe(true);
  });

  test("rejects a business_info.locations[] entry missing location_id", () => {
    const v = validate();
    const fixture = loadFixture("scraper-output", "valid-multi-location") as any;
    const broken = JSON.parse(JSON.stringify(fixture));
    delete broken.data.business_info.locations[0].location_id;
    expect(v(broken)).toBe(false);
  });
});
