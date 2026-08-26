// Pure, tested encoding of scraper-agent.md's `completeness` self-assessment
// rule (see docs/superpowers/specs/2026-08-26-multi-location-schema-and-
// kickoff-validation-design.md, section 1.10, for the full reasoning).
//
// Not wired into any agent's Bash allowlist or called at runtime — its job
// is to make the threshold rule executable and testable instead of prose an
// agent has to interpret by eye each run. scraper-agent.md's own prose is
// written to state this exact rule, so the two are kept in agreement by
// construction, not by cross-checking.

export type SourcedFieldConfidence = "verified" | "inferred" | "missing";
export type SourcedFieldSource = "own_site" | "places_api" | "web_search" | "not_found";

export interface SourcedField<T> {
  value: T | null;
  source: SourcedFieldSource;
  confidence: SourcedFieldConfidence;
}

export interface CompletenessLocation {
  location_id: string;
  address: SourcedField<string>;
  phone: SourcedField<string>;
  hours: SourcedField<string>;
}

export interface CompletenessInput {
  business_info: {
    name: SourcedField<string>;
    locations: CompletenessLocation[];
  };
  content_found: Array<{ text_blocks: string[] }>;
  reviews: {
    by_location: Array<{ aggregate_rating: SourcedField<number> }>;
    own_site_testimonials: unknown[];
  };
}

export type Completeness = "good" | "partial" | "poor";

export function assessCompleteness(data: CompletenessInput): Completeness {
  const { name, locations } = data.business_info;

  const nameUnresolved = name.confidence === "missing";
  const lowConfidenceIdentityGuess = name.source === "web_search" && name.confidence === "inferred";
  if (nameUnresolved || lowConfidenceIdentityGuess) {
    return "poor";
  }

  const anyLocationFailsGoodBar = locations.some((loc) => {
    const missingCount = [loc.address, loc.phone, loc.hours].filter(
      (f) => f.confidence === "missing"
    ).length;
    return loc.address.confidence === "missing" || loc.phone.confidence === "missing" || missingCount >= 2;
  });

  const hasUsableText = data.content_found.some((item) => item.text_blocks.length > 0);

  const hasReviewsSignal =
    data.reviews.by_location.some((loc) => loc.aggregate_rating.confidence !== "missing") ||
    data.reviews.own_site_testimonials.length > 0;

  if (anyLocationFailsGoodBar || !hasUsableText || !hasReviewsSignal) {
    return "partial";
  }

  return "good";
}
