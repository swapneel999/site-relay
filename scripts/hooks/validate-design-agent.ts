#!/usr/bin/env bun
// PreToolUse hook for the design-agent subagent (wired via that agent's own
// frontmatter `hooks:` field, so this only runs while design-agent is active
// — see .claude/agents/design-agent.md).
//
// Unlike the scraper's allow-list (which only ever writes brand-new files),
// design-agent legitimately needs broad Write/Edit access — building the
// site IS its job. So this is a deny-list, not an allow-list: it blocks the
// four pipeline files design-agent must never touch under any circumstance
// (kickoff.json, scraper-output.json, signoff.json, pipeline-status.json —
// each owned by a different agent/process, per docs/spec.md's write-
// ownership rules) and allows everything else, including design-lock.json,
// mockup-approval.json, and qa-report.json.
//
// For the latter two, this hook ALSO enforces one narrow, cheap invariant on
// top of the system-prompt-enforced field rules: `data.rounds[]` may never
// shrink or lose a round that already existed. This falls well short of full
// field-level diffing (still not attempted — see the "Hook enforcement
// depth" note in .claude/agents/design-agent.md for why that fuller scope
// was declined, not overlooked) but it's a real, cheap backstop against the
// specific failure mode of an agent (accidentally or otherwise) clobbering
// round history, which the append-only pattern used everywhere else in this
// pipeline (component_catalog, generated_assets) treats as an integrity
// requirement, not a nice-to-have.
//
// This hook ALSO gates one specific Bash invocation: "npx impeccable detect
// ... --json", design-agent's final whole-page anti-pattern sweep before its
// closing screenshot (see design-agent.md's "Final design-quality sweep"
// step). This is deliberately a single narrow allow-listed island inside an
// otherwise-open Bash surface, not a conversion to scraper/qa's full
// allow-list model — design-agent's Bash access stays broad everywhere else
// (npm/bun/git/curl, server-lifecycle.ts, generate-image.ts, etc.), because
// building the site requires it. Only a command that actually mentions
// "impeccable" gets scrutinized at all; anything else passes straight
// through unrestricted, same as before this check existed. The point of the
// gate is narrow: once this agent is instructed to run `impeccable detect`,
// it must never be able to slide into `impeccable install/link/update/check`
// (the skill-management/plugin subcommands — mutating global skill state is
// not this agent's job) by a typo, a prompt-injected suggestion from
// somewhere else in its context, or a bare "npx impeccable" with no
// subcommand at all.
//
// Usage (from hook config): bun scripts/hooks/validate-design-agent.ts [bash]
// Reads Claude Code's PreToolUse JSON payload from stdin. With no argv (the
// original "Write|Edit" wiring, kept exactly as-is for backward
// compatibility with every existing caller/test of this script) it runs the
// write/edit deny-list below. With "bash" as argv[2] (the new "Bash" matcher
// entry in design-agent.md's frontmatter) it runs the impeccable-detect gate
// instead. Exit 0 = allow, exit 2 = block (stderr text is surfaced back to
// the agent as the reason).

export {};

import { posix } from "node:path";
import { readFileSync } from "node:fs";

const mode = process.argv[2];

function block(reason: string): never {
  console.error(reason);
  process.exit(2);
}

function allow(): never {
  process.exit(0);
}

const raw = await new Response(Bun.stdin.stream()).text();

let input: { tool_name?: string; tool_input?: Record<string, unknown> };
try {
  input = JSON.parse(raw);
} catch {
  block("design-agent hook: could not parse PreToolUse JSON payload from stdin");
}

if (mode === "bash") {
  const command = String(input.tool_input?.command ?? "");

  // Same real bypass vectors as every other Bash entry in this pipeline
  // (scraper-agent's and qa-agent's hooks): backtick and bare "$" (command
  // substitution / parameter expansion survive even inside double quotes),
  // plus newline.
  if (/[`$\n]/.test(command)) {
    block(`design-agent Bash: command contains a backtick, "$", or newline — blocked "${command}"`);
  }

  const trimmed = command.trim();

  // Only commands that actually reference impeccable get scrutinized at all
  // — everything else (npm/bun/git/curl/server-lifecycle.ts/generate-image.ts/
  // etc.) is unrestricted, per design-agent's normal broad Bash access.
  // Case-insensitive so a case-swapped "Impeccable"/"IMPECCABLE" can't dodge
  // the check by missing this detector while still resolving to the same
  // real binary on a case-insensitive filesystem/shell lookup.
  const mentionsImpeccable = /impeccable/i.test(trimmed);

  if (mentionsImpeccable) {
    // Anchored end-to-end: the path argument must be wrapped in literal
    // double quotes (same convention as scraper-agent's --query "...", which
    // neutralizes ;/&/|/</> by relying on the shell's own quoting rules
    // rather than trying to deny-list every shell metacharacter here) with
    // no embedded literal `"` — combined with the backtick/$/newline block
    // above, that closes the same gap scraper's hook already reasoned
    // through for its own quoted argument. Only "detect" is permitted as the
    // subcommand: "install"/"link"/"update"/"check", a bare "npx impeccable"
    // with no subcommand, or anything else impeccable-flavored all fail this
    // anchored match and fall through to the block below.
    const isAllowedDetect =
      /^npx impeccable detect "[^"]+" --json( --scope [A-Za-z,]+)?( --no-advisory)?$/.test(trimmed);

    if (!isAllowedDetect) {
      block(
        `design-agent Bash: impeccable invocations are restricted to 'npx impeccable detect "<path>" --json [--scope <domains>] [--no-advisory]' — blocked "${trimmed}"`
      );
    }
  }

  allow();
}

const rawPath = String(input.tool_input?.file_path ?? "");
// posix.normalize collapses ".." segments lexically, so a disguised path
// like ".pipeline/scraper-cache/../kickoff.json" is caught rather than
// slipping past a literal-suffix check. Lowercased because macOS (default)
// and Windows are both case-insensitive filesystems — ".PIPELINE/Kickoff.json"
// resolves to the same real file as the protected one, and a case-sensitive
// comparison here would silently miss that.
const normalized = posix.normalize(rawPath.replace(/\\/g, "/")).toLowerCase();

const PROTECTED_EXACT = new Set([
  ".pipeline/kickoff.json",
  ".pipeline/scraper-output.json",
  ".pipeline/signoff.json",
  ".pipeline/pipeline-status.json",
]);
const PROTECTED_SUFFIXES = [
  "/.pipeline/kickoff.json",
  "/.pipeline/scraper-output.json",
  "/.pipeline/signoff.json",
  "/.pipeline/pipeline-status.json",
];

const OWNER_BY_FILE: Record<string, string> = {
  "kickoff.json": "human/intake",
  "scraper-output.json": "scraper agent",
  "signoff.json": "integration lead / client-approval intake",
  "pipeline-status.json": "orchestrator",
};

const basename = normalized.split("/").pop()!;

const isProtected =
  PROTECTED_EXACT.has(normalized) ||
  PROTECTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));

if (isProtected) {
  block(
    `design-agent may never write to "${basename}" (blocked: "${rawPath}") — owned exclusively by ${OWNER_BY_FILE[basename] ?? "another agent/process"}, per docs/spec.md's write-ownership rules.`
  );
}

// --- Round-immutability check for mockup-approval.json / qa-report.json ---

const ROUND_TRACKED_FILES = new Set(["mockup-approval.json", "qa-report.json"]);

function computeNewContent(
  toolName: string,
  toolInput: Record<string, unknown>,
  oldContent: string | null
): string | null {
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  if (toolName === "Edit") {
    if (oldContent === null) return null; // can't simulate an edit against a file we couldn't read
    const oldString = String(toolInput.old_string ?? "");
    const newString = String(toolInput.new_string ?? "");
    if (oldString === "" || !oldContent.includes(oldString)) return null; // can't reliably simulate
    return toolInput.replace_all
      ? oldContent.split(oldString).join(newString)
      : oldContent.replace(oldString, newString);
  }
  return null;
}

function extractRoundNumbers(jsonText: string | null): Set<number> | null {
  if (jsonText === null) return null;
  try {
    const parsed = JSON.parse(jsonText);
    const rounds = parsed?.data?.rounds;
    if (!Array.isArray(rounds)) return new Set();
    return new Set(
      rounds.map((r: unknown) => (r as { round?: unknown })?.round).filter((n): n is number => typeof n === "number")
    );
  } catch {
    return null;
  }
}

if (ROUND_TRACKED_FILES.has(basename)) {
  let oldContent: string | null;
  try {
    oldContent = readFileSync(rawPath, "utf-8");
  } catch {
    oldContent = null; // doesn't exist yet — first write, nothing to protect
  }

  const newContent = computeNewContent(String(input.tool_name ?? ""), input.tool_input ?? {}, oldContent);
  const oldRounds = extractRoundNumbers(oldContent);
  const newRounds = extractRoundNumbers(newContent);

  // Only enforce when both sides were determinable — if we can't reliably
  // read/simulate one side (e.g. an Edit whose old_string didn't match, or
  // content that isn't valid JSON yet mid-edit), degrade to allowing rather
  // than blocking on a check we can't actually perform. The four-file
  // deny-list above is this hook's real guarantee; this is a bonus.
  if (oldRounds && oldRounds.size > 0 && newRounds) {
    if (newRounds.size < oldRounds.size) {
      block(
        `design-agent: "${basename}"'s round count may not decrease (had ${oldRounds.size}, would become ${newRounds.size}) — rounds are append-only, blocked write to "${rawPath}"`
      );
    }
    const missing = [...oldRounds].filter((r) => !newRounds.has(r));
    if (missing.length > 0) {
      block(
        `design-agent: round(s) ${missing.join(", ")} would be removed from "${basename}" — rounds are append-only, blocked write to "${rawPath}"`
      );
    }
  }
}

allow();
