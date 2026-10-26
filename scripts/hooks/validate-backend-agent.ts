#!/usr/bin/env bun
// PreToolUse hook for the backend-agent subagent (wired via that agent's own
// frontmatter `hooks:` field, so this only runs while backend-agent is active
// — see .claude/agents/backend-agent.md).
//
// Adapted from scripts/hooks/validate-design-agent.ts rather than written
// from scratch — same deny-list model (backend-agent needs broad Write/Edit
// access to wire real server logic, so this blocks specific files rather
// than allow-listing), same case-insensitive/".."-traversal-safe path
// normalization, same round-immutability check on mockup-approval.json/
// qa-report.json. The one real difference: backend-agent's protected set is
// FIVE files, not four — it adds design-lock.json on top of design-agent's
// four, because design-lock.json's tokens/component_catalog are the design
// agent's exclusively; backend-agent reads it as reference only and must
// never write it (see docs/spec.md's write-ownership rules).
//
// Usage (from hook config): bun scripts/hooks/validate-backend-agent.ts
// Reads Claude Code's PreToolUse JSON payload from stdin (matcher "Write|Edit"
// so both tools land here). Exit 0 = allow, exit 2 = block (stderr text is
// surfaced back to the agent as the reason).

export {};

import { posix } from "node:path";
import { readFileSync } from "node:fs";

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
  block("backend-agent hook: could not parse PreToolUse JSON payload from stdin");
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
  ".pipeline/design-lock.json",
]);
const PROTECTED_SUFFIXES = [
  "/.pipeline/kickoff.json",
  "/.pipeline/scraper-output.json",
  "/.pipeline/signoff.json",
  "/.pipeline/pipeline-status.json",
  "/.pipeline/design-lock.json",
];

const OWNER_BY_FILE: Record<string, string> = {
  "kickoff.json": "human/intake",
  "scraper-output.json": "scraper agent",
  "signoff.json": "integration lead / client-approval intake",
  "pipeline-status.json": "orchestrator",
  "design-lock.json": "design agent",
};

const basename = normalized.split("/").pop()!;

const isProtected =
  PROTECTED_EXACT.has(normalized) ||
  PROTECTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));

if (isProtected) {
  block(
    `backend-agent may never write to "${basename}" (blocked: "${rawPath}") — owned exclusively by ${OWNER_BY_FILE[basename] ?? "another agent/process"}, per docs/spec.md's write-ownership rules.`
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
  // than blocking on a check we can't actually perform. The five-file
  // deny-list above is this hook's real guarantee; this is a bonus.
  if (oldRounds && oldRounds.size > 0 && newRounds) {
    if (newRounds.size < oldRounds.size) {
      block(
        `backend-agent: "${basename}"'s round count may not decrease (had ${oldRounds.size}, would become ${newRounds.size}) — rounds are append-only, blocked write to "${rawPath}"`
      );
    }
    const missing = [...oldRounds].filter((r) => !newRounds.has(r));
    if (missing.length > 0) {
      block(
        `backend-agent: round(s) ${missing.join(", ")} would be removed from "${basename}" — rounds are append-only, blocked write to "${rawPath}"`
      );
    }
  }
}

allow();
