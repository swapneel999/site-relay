import { describe, expect, test } from "bun:test";
import { assessCompleteness, type CompletenessInput, type SourcedField } from "../../lib/scraper-completeness";

function verified<T>(value: T, source: SourcedField<T>["source"] = "own_site"): SourcedField<T> {
  return { value, source, confidence: "verified" };
}

function missing<T>(): SourcedField<T> {
  return { value: null, source: "not_found", confidence: "missing" };
}

function inferredFromWebSearch<T>(value: T): SourcedField<T> {
  return { value, source: "web_search", confidence: "inferred" };
}

const baseContentFound = [{ text_blocks: ["Some real page text."] }];
const baseReviewsWithSignal = {
  by_location: [{ aggregate_rating: verified(4.8) }],
  own_site_testimonials: [],
};
const emptyReviews = { by_location: [{ aggregate_rating: missing<number>() }], own_site_testimonials: [] };

describe("assessCompleteness", () => {
  test("exact reduction: single-location, address+phone verified, hours missing — matches the pre-existing single-location 'good' bar (the 'not hours' carve-out)", () => {
    const input: CompletenessInput = {
      business_info: {
        name: verified("Acme Plumbing"),
        locations: [
          {
            location_id: "main",
            address: verified("123 Main St"),
            phone: verified("+1-555-0100"),
            hours: missing(),
          },
        ],
      },
      content_found: baseContentFound,
      reviews: baseReviewsWithSignal,
    };
    expect(assessCompleteness(input)).toBe("good");
  });

  test("multi-location: both locations fully resolved — good", () => {
    const input: CompletenessInput = {
      business_info: {
        name: verified("Chaiverse"),
        locations: [
          { location_id: "geelong", address: verified("23 Cuzens Place"), phone: verified("+61 401 188 283"), hours: verified("9am-9pm") },
          { location_id: "werribee", address: verified("6/57-61 Synnot St"), phone: verified("+61 401 188 284"), hours: verified("9am-9pm") },
        ],
      },
      content_found: baseContentFound,
      reviews: {
        by_location: [
          { aggregate_rating: verified(4.9) },
          { aggregate_rating: verified(4.7) },
        ],
        own_site_testimonials: [],
      },
    };
    expect(assessCompleteness(input)).toBe("good");
  });

  test("multi-location: one fully resolved, one missing only phone — partial, not good (meaningfully different from failing both, but not a free pass)", () => {
    const input: CompletenessInput = {
      business_info: {
        name: verified("Chaiverse"),
        locations: [
          { location_id: "geelong", address: verified("23 Cuzens Place"), phone: verified("+61 401 188 283"), hours: verified("9am-9pm") },
          { location_id: "werribee", address: verified("6/57-61 Synnot St"), phone: missing(), hours: verified("9am-9pm") },
        ],
      },
      content_found: baseContentFound,
      reviews: baseReviewsWithSignal,
    };
    expect(assessCompleteness(input)).toBe("partial");
  });

  test("multi-location: one fully resolved, one entirely not_found on address+phone+hours — still partial, not poor (total per-location failure doesn't escalate past partial while name is known)", () => {
    const input: CompletenessInput = {
      business_info: {
        name: verified("Chaiverse"),
        locations: [
          { location_id: "geelong", address: verified("23 Cuzens Place"), phone: verified("+61 401 188 283"), hours: verified("9am-9pm") },
          { location_id: "werribee", address: missing(), phone: missing(), hours: missing() },
        ],
      },
      content_found: baseContentFound,
      reviews: baseReviewsWithSignal,
    };
    expect(assessCompleteness(input)).toBe("partial");
  });

  test("name unresolved — poor", () => {
    const input: CompletenessInput = {
      business_info: {
        name: missing(),
        locations: [
          { location_id: "main", address: verified("123 Main St"), phone: verified("+1-555-0100"), hours: verified("9am-5pm") },
        ],
      },
      content_found: baseContentFound,
      reviews: baseReviewsWithSignal,
    };
    expect(assessCompleteness(input)).toBe("poor");
  });

  test("name resolved only via a low-confidence web_search guess — poor", () => {
    const input: CompletenessInput = {
      business_info: {
        name: inferredFromWebSearch("Maybe Acme Plumbing?"),
        locations: [
          { location_id: "main", address: verified("123 Main St"), phone: verified("+1-555-0100"), hours: verified("9am-5pm") },
        ],
      },
      content_found: baseContentFound,
      reviews: baseReviewsWithSignal,
    };
    expect(assessCompleteness(input)).toBe("poor");
  });

  test("reviews signal empty everywhere (no ratings, no testimonials) despite everything else resolved — partial", () => {
    const input: CompletenessInput = {
      business_info: {
        name: verified("Acme Plumbing"),
        locations: [
          { location_id: "main", address: verified("123 Main St"), phone: verified("+1-555-0100"), hours: verified("9am-5pm") },
        ],
      },
      content_found: baseContentFound,
      reviews: emptyReviews,
    };
    expect(assessCompleteness(input)).toBe("partial");
  });

  test("no usable content_found text blocks — partial", () => {
    const input: CompletenessInput = {
      business_info: {
        name: verified("Acme Plumbing"),
        locations: [
          { location_id: "main", address: verified("123 Main St"), phone: verified("+1-555-0100"), hours: verified("9am-5pm") },
        ],
      },
      content_found: [{ text_blocks: [] }],
      reviews: baseReviewsWithSignal,
    };
    expect(assessCompleteness(input)).toBe("partial");
  });
});
