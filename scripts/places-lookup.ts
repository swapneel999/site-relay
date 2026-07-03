#!/usr/bin/env bun
// CLI wrapper around Google Places API (New), so the scraper agent can look up
// business data via `Bash` without ever seeing the raw API key — it stays in
// this process's env, read once here, never echoed or logged.
//
// Usage:
//   bun scripts/places-lookup.ts search --query "Acme Plumbing, Denver, CO"
//   bun scripts/places-lookup.ts details --place-id ChIJ...
//
// Requires GOOGLE_PLACES_API_KEY in the environment (Google Cloud billing +
// Places API (New) enabled — a separate setup from any consumer API key).

export {}; // marks this file as a module so top-level await is valid

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

if (!API_KEY) {
  fail("GOOGLE_PLACES_API_KEY is not set in the environment.");
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      args[key] = value ?? "";
      i++;
    }
  }
  return args;
}

async function searchText(query: string) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY!,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: query }),
  });
  if (!res.ok) {
    fail(`Places searchText failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function placeDetails(placeId: string) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": API_KEY!,
      "X-Goog-FieldMask": [
        "id", "displayName", "formattedAddress", "internationalPhoneNumber",
        "regularOpeningHours", "priceLevel", "types", "rating", "userRatingCount",
        "reviews",
      ].join(","),
    },
  });
  if (!res.ok) {
    fail(`Places details failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const [, , command] = process.argv;
const args = parseArgs(process.argv.slice(3));

if (command === "search") {
  if (!args.query) fail("search requires --query \"business name, address\"");
  const result = await searchText(args.query);
  console.log(JSON.stringify(result));
} else if (command === "details") {
  if (!args["place-id"]) fail("details requires --place-id <id>");
  const result = await placeDetails(args["place-id"]);
  console.log(JSON.stringify(result));
} else {
  fail(`Unknown command "${command}". Use "search" or "details".`);
}
