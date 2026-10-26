import { describe, test, expect } from "bun:test";
import { compileSchema, listClientIds, pipelineFileExists, loadPipelineFile } from "./helpers";

// Validates the scraper agent's ACTUAL output for every real client under
// clients/<client_id>/.pipeline/, not a hand-written example fixture. Each
// client self-skips independently until it has actually run through
// scraping (see the "Dry run & validation" section of
// .claude/agents/scraper-agent.md).
const clientIds = listClientIds();

describe("scraper agent dry run — .pipeline/scraper-output.json", () => {
  test.skipIf(clientIds.length > 0)(
    "no real clients found under clients/ (expected in a fresh checkout with no live client work yet)",
    () => {
      expect(clientIds.length).toBe(0);
    }
  );

  for (const clientId of clientIds) {
    const hasDryRunOutput = pipelineFileExists(clientId, "scraper-output.json");

    test.skipIf(!hasDryRunOutput)(
      `[${clientId}] actual scraper output validates against schemas/scraper-output.schema.json`,
      () => {
        const validate = compileSchema("scraper-output.schema.json");
        const output = loadPipelineFile(clientId, "scraper-output.json");
        const ok = validate(output);
        if (!ok) {
          throw new Error(
            `clients/${clientId}/.pipeline/scraper-output.json failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`
          );
        }
        expect(ok).toBe(true);
      }
    );

    test.skipIf(!hasDryRunOutput)(
      `[${clientId}] reviews.by_location[] location_ids are a subset of business_info.locations[] location_ids, and neither array has duplicates`,
      () => {
        const output = loadPipelineFile(clientId, "scraper-output.json") as any;
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
      `[${clientId}] no scraper-output.json yet (expected before this client reaches scraping)`,
      () => {
        expect(hasDryRunOutput).toBe(false);
      }
    );
  }
});
