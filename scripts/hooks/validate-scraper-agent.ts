#!/usr/bin/env bun
// PreToolUse hook for the scraper-agent subagent (wired via that agent's own
// frontmatter `hooks:` field, so this only runs while scraper-agent is
// active — see .claude/agents/scraper-agent.md).
//
// Enforces, for real, the two boundaries that used to be prose-only:
//   - Write may only target .pipeline/scraper-output.json or .pipeline/scraper-cache/**
//   - Bash may only run the places-lookup script or the dry-run validation test
//
// Usage (from hook config): bun scripts/hooks/validate-scraper-agent.ts write|bash
// Reads Claude Code's PreToolUse JSON payload from stdin. Exit 0 = allow,
// exit 2 = block (stderr text is surfaced back to the agent as the reason).

export {};

const mode = process.argv[2];

function block(reason: string): never {
  console.error(reason);
  process.exit(2);
}

function allow(): never {
  process.exit(0);
}

const raw = await new Response(Bun.stdin.stream()).text();

let input: { tool_input?: Record<string, unknown> };
try {
  input = JSON.parse(raw);
} catch {
  block("scraper-agent hook: could not parse PreToolUse JSON payload from stdin");
}

if (mode === "write") {
  const rawPath = String(input.tool_input?.file_path ?? "");
  const filePath = rawPath.replace(/\\/g, "/");

  if (filePath.includes("..")) {
    block(`scraper-agent Write: path traversal ("..") is not allowed — blocked "${rawPath}"`);
  }

  // Claude Code's Write tool contract requires an absolute file_path, so in
  // practice this is always the endsWith/includes form below — but accept
  // the bare-relative form too (exact match / startsWith) as a defensive
  // fallback in case that ever changes or a caller passes one anyway.
  const isScraperOutput =
    filePath === ".pipeline/scraper-output.json" ||
    filePath.endsWith("/.pipeline/scraper-output.json");
  const isScraperCache =
    filePath.startsWith(".pipeline/scraper-cache/") ||
    filePath.includes("/.pipeline/scraper-cache/");
  const allowed = isScraperOutput || isScraperCache;

  if (!allowed) {
    block(
      `scraper-agent may only write .pipeline/scraper-output.json or .pipeline/scraper-cache/** — blocked write to "${rawPath}"`
    );
  }
  allow();
} else if (mode === "bash") {
  const command = String(input.tool_input?.command ?? "");

  // Backtick, bare "$", and newline are the real bypass vectors here: bash
  // suppresses word-splitting and globbing inside double quotes, but NOT
  // command substitution ($(...) or `...`) or parameter expansion ($var /
  // ${var}) — "${GOOGLE_PLACES_API_KEY}" inside a quoted --query argument
  // would expand and exfiltrate that env var into the request before bun
  // ever sees the argument. Blocking any "$" at all (not just "$(") closes
  // that off, including bare $VAR with no parens/braces.
  // ";", "&", "|", "<", ">" don't need blocking — deliberately NOT in this
  // list, since they're common in real business names ("Smith & Sons",
  // "AT&T") and anything after a closing quote (or one of these chars
  // outside quotes) already fails the anchored allowlist regexes' `$`
  // end-of-string requirement below on its own.
  if (/[`$\n]/.test(command)) {
    block(`scraper-agent Bash: command contains a backtick, "$", or newline — blocked "${command}"`);
  }

  const trimmed = command.trim();
  const isPlacesLookup =
    /^bun scripts\/places-lookup\.ts search --query "[^"]+"$/.test(trimmed) ||
    /^bun scripts\/places-lookup\.ts details --place-id [A-Za-z0-9_-]+$/.test(trimmed);
  const isValidationTest = trimmed === "bun test tests/agents/scraper-output.dry-run.test.ts";

  if (!isPlacesLookup && !isValidationTest) {
    block(
      `scraper-agent Bash is restricted to "bun scripts/places-lookup.ts search|details ..." and the dry-run validation test — blocked "${trimmed}"`
    );
  }
  allow();
} else {
  block(`scraper-agent hook: unknown mode "${mode}" (expected "write" or "bash")`);
}
