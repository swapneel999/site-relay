#!/usr/bin/env bun
// PreToolUse hook for the integration-lead-agent subagent (wired via that
// agent's own frontmatter `hooks:` field — see
// .claude/agents/integration-lead-agent.md).
//
// Allow-list model, same shape as qa-agent's hook: this agent's legitimate
// write surface is exactly one file (.pipeline/signoff.json — NOT
// clients.json, which belongs to scripts/onboard-client.ts, a different,
// non-agent script entirely), and its legitimate Bash surface is a small,
// fixed set of read-only checks plus two genuinely mutating calls
// (github-repo.ts push — the final QA-passed code, pushed here rather than
// incrementally by design/backend/QA since none of those three need a push
// for their own local-server testing — and vercel-deploy.ts promote).
//
// Usage (from hook config): bun scripts/hooks/validate-integration-lead-agent.ts write|bash
// Reads Claude Code's PreToolUse JSON payload from stdin. Exit 0 = allow,
// exit 2 = block (stderr text is surfaced back to the agent as the reason).

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
  block("integration-lead-agent hook: could not parse PreToolUse JSON payload from stdin");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type Round = { round?: unknown; client_final_approval?: unknown };

function extractRounds(jsonText: string | null): Round[] | null {
  if (jsonText === null) return null;
  try {
    const parsed = JSON.parse(jsonText);
    const rounds = parsed?.data?.review_rounds;
    return Array.isArray(rounds) ? rounds : [];
  } catch {
    return null;
  }
}

// The write-pattern boundary for signoff.json — simpler than qa-report.json's
// because there's no cross-round reconciliation here at all: integration-
// lead has no reopened-finding-style chain and no legitimate reason to ever
// touch a review round that's already closed out. What's enforced:
//   1. Round-count/round-identity: unchanged from every other pipeline
//      file's round-immutability rule — rounds never shrink.
//   2. Every round except the highest-numbered one (the "current" round) is
//      frozen ENTIRELY — not just specific fields, the whole round object —
//      since integration-lead genuinely never has business editing a closed
//      round, unlike QA's later reconciliation passes.
//   3. Within the current round, client_final_approval must be byte-
//      identical before and after — that field is client-approval intake's
//      exclusively, enforced here the same way a terminal QA finding is
//      frozen from QA's own future writes.
function checkSignoffInvariants(oldContent: string | null, newContent: string | null): string | null {
  const oldRounds = extractRounds(oldContent);
  const newRounds = extractRounds(newContent);

  if (oldRounds === null || newRounds === null) return null;
  if (oldRounds.length === 0) return null;

  const oldRoundNumbers = new Set(oldRounds.map((r) => r.round).filter((n): n is number => typeof n === "number"));
  const newRoundNumbers = new Set(newRounds.map((r) => r.round).filter((n): n is number => typeof n === "number"));

  if (newRoundNumbers.size < oldRoundNumbers.size) {
    return `signoff.json's round count may not decrease (had ${oldRoundNumbers.size}, would become ${newRoundNumbers.size}) — review_rounds is append-only`;
  }
  const missingRounds = [...oldRoundNumbers].filter((r) => !newRoundNumbers.has(r));
  if (missingRounds.length > 0) {
    return `round(s) ${missingRounds.join(", ")} would be removed from signoff.json — review_rounds is append-only`;
  }

  const newRoundsByNumber = new Map<number, Round>();
  for (const r of newRounds) {
    if (typeof r.round === "number") newRoundsByNumber.set(r.round, r);
  }
  const currentRoundNumber = newRoundNumbers.size > 0 ? Math.max(...newRoundNumbers) : null;

  for (const oldRound of oldRounds) {
    if (typeof oldRound.round !== "number") continue;
    const newRound = newRoundsByNumber.get(oldRound.round);
    if (!newRound) continue; // already reported above as a missing round

    const isCurrentRound = currentRoundNumber === null || oldRound.round === currentRoundNumber;

    if (!isCurrentRound) {
      if (stableStringify(oldRound) !== stableStringify(newRound)) {
        return `round ${oldRound.round} in signoff.json is no longer current — the entire round is frozen once a later round exists, blocked write`;
      }
      continue;
    }

    // Current round: client_final_approval is the one field even the
    // current round's own writer (you) may never touch.
    if (stableStringify(oldRound.client_final_approval) !== stableStringify(newRound.client_final_approval)) {
      return `round ${oldRound.round}'s client_final_approval may not be written by integration-lead-agent — that field belongs exclusively to client-approval intake`;
    }
  }

  return null;
}

function computeNewContent(
  toolName: string,
  toolInput: Record<string, unknown>,
  oldContent: string | null
): string | null {
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  if (toolName === "Edit") {
    if (oldContent === null) return null;
    const oldString = String(toolInput.old_string ?? "");
    const newString = String(toolInput.new_string ?? "");
    if (oldString === "" || !oldContent.includes(oldString)) return null;
    return toolInput.replace_all
      ? oldContent.split(oldString).join(newString)
      : oldContent.replace(oldString, newString);
  }
  return null;
}

if (mode === "write") {
  const rawPath = String(input.tool_input?.file_path ?? "");
  const normalized = posix.normalize(rawPath.replace(/\\/g, "/")).toLowerCase();

  const isSignoff = normalized === ".pipeline/signoff.json" || normalized.endsWith("/.pipeline/signoff.json");

  if (!isSignoff) {
    block(`integration-lead-agent may only write ".pipeline/signoff.json" — blocked write to "${rawPath}" (clients.json belongs to scripts/onboard-client.ts, not this agent)`);
  }

  let oldContent: string | null;
  try {
    oldContent = readFileSync(rawPath, "utf-8");
  } catch {
    oldContent = null;
  }
  const newContent = computeNewContent(String(input.tool_name ?? ""), input.tool_input ?? {}, oldContent);

  const violation = checkSignoffInvariants(oldContent, newContent);
  if (violation) block(`integration-lead-agent: ${violation}`);

  allow();
} else if (mode === "bash") {
  const command = String(input.tool_input?.command ?? "");

  if (/[`$\n]/.test(command)) {
    block(`integration-lead-agent Bash: command contains a backtick, "$", or newline — blocked "${command}"`);
  }

  const trimmed = command.trim();

  // Clean-tree check before pushing — read-only, no GitHub token involved.
  const isGitStatus = /^git -C \S+ status --porcelain$/.test(trimmed);

  // The one GitHub-touching call this agent makes: push whatever is
  // already committed. NOT verify-access, NOT repo creation — both stay
  // onboarding-exclusive (scripts/onboard-client.ts), there's nothing here
  // to re-verify that onboarding didn't already confirm once.
  const isGithubPush =
    /^bun scripts\/github-repo\.ts push --owner \S+ --repo \S+ --installation-id \S+ --cwd \S+ --branch \S+( --dry-run)?$/.test(
      trimmed
    );

  // Read-only git checks, run AFTER the push to independently confirm it
  // actually landed rather than trusting github-repo.ts's own exit code
  // alone.
  const isGitFetch = /^git -C \S+ fetch$/.test(trimmed);
  const isGitRevParseHead = /^git -C \S+ rev-parse HEAD$/.test(trimmed);
  const isGitRevParseRemote = /^git -C \S+ rev-parse origin\/\S+$/.test(trimmed);

  // vercel-deploy.ts: env-list/check-preview/domain-check/promote only —
  // never create-project, that subcommand exists only for onboarding.
  const isVercelEnvList = /^bun scripts\/vercel-deploy\.ts env-list --project \S+$/.test(trimmed);
  const isVercelCheckPreview = /^bun scripts\/vercel-deploy\.ts check-preview --project \S+$/.test(trimmed);
  const isVercelDomainCheck = /^bun scripts\/vercel-deploy\.ts domain-check --project \S+ --domain \S+$/.test(trimmed);
  const isVercelPromote = /^bun scripts\/vercel-deploy\.ts promote --project \S+ --deployment \S+( --dry-run)?$/.test(trimmed);

  const isValidationTest = trimmed === "bun test tests/agents/signoff-output.dry-run.test.ts";

  const allowed =
    isGitStatus ||
    isGithubPush ||
    isGitFetch ||
    isGitRevParseHead ||
    isGitRevParseRemote ||
    isVercelEnvList ||
    isVercelCheckPreview ||
    isVercelDomainCheck ||
    isVercelPromote ||
    isValidationTest;

  if (!allowed) {
    block(
      `integration-lead-agent Bash is restricted to a clean-tree check, "github-repo.ts push" (never verify-access or repo creation), read-only git checks, "vercel-deploy.ts" (env-list/check-preview/domain-check/promote only — never create-project), and the dry-run validation test — blocked "${trimmed}"`
    );
  }
  allow();
} else {
  block(`integration-lead-agent hook: unknown mode "${mode}" (expected "write" or "bash")`);
}
