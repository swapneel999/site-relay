import { describe, test, expect } from "bun:test";
import { compileSchema, pipelineFileExists, loadPipelineFile } from "./helpers";

// This test validates the SCRAPER AGENT'S ACTUAL OUTPUT, not a hand-written
// example fixture. It only has something to check once a real dry run has
// produced .pipeline/scraper-output.json (see the "Dry run & validation"
// section of .claude/agents/scraper-agent.md) — this repo has no live client,
// so by default there's nothing here yet and the test self-skips rather than
// failing forever on a file that was never supposed to exist in this repo.
const hasDryRunOutput = pipelineFileExists("scraper-output.json");

describe("scraper agent dry run — .pipeline/scraper-output.json", () => {
  test.skipIf(!hasDryRunOutput)(
    "actual scraper output validates against schemas/scraper-output.schema.json",
    () => {
      const validate = compileSchema("scraper-output.schema.json");
      const output = loadPipelineFile("scraper-output.json");
      const ok = validate(output);
      if (!ok) {
        throw new Error(
          `.pipeline/scraper-output.json failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`
        );
      }
      expect(ok).toBe(true);
    }
  );

  test.skipIf(!hasDryRunOutput)(
    "reviews.by_location[] location_ids are a subset of business_info.locations[] location_ids, and neither array has duplicates",
    () => {
      const output = loadPipelineFile("scraper-output.json") as any;
      const businessLocationIds: string[] = output.data.business_info.locations.map(
        (loc: any) => loc.location_id
      );
      const reviewLocationIds: string[] = output.data.reviews.by_location.map(
        (entry: any) => entry.location_id
      );
      const businessLocationIdSet = new Set(businessLocationIds);

      for (const locationId of reviewLocationIds) {
        expect(
          businessLocationIdSet.has(locationId),
          `reviews.by_location[] references location_id "${locationId}" which does not appear in business_info.locations[]`
        ).toBe(true);
      }

      const findDuplicate = (ids: string[]): string | undefined => {
        const seen = new Set<string>();
        for (const id of ids) {
          if (seen.has(id)) return id;
          seen.add(id);
        }
        return undefined;
      };

      const duplicateBusinessLocationId = findDuplicate(businessLocationIds);
      expect(
        duplicateBusinessLocationId,
        `business_info.locations[] contains duplicate location_id "${duplicateBusinessLocationId}"`
      ).toBeUndefined();

      const duplicateReviewLocationId = findDuplicate(reviewLocationIds);
      expect(
        duplicateReviewLocationId,
        `reviews.by_location[] contains duplicate location_id "${duplicateReviewLocationId}"`
      ).toBeUndefined();
    }
  );

  test.skipIf(hasDryRunOutput)(
    "no dry run performed yet (expected in this repo — run the scraper agent against a sample kickoff.json to exercise this check)",
    () => {
      expect(hasDryRunOutput).toBe(false);
    }
  );
});
