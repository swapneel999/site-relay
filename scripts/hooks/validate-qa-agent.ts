#!/usr/bin/env bun
// PreToolUse hook for the qa-agent subagent (wired via that agent's own
// frontmatter `hooks:` field, so this only runs while qa-agent is active —
// see .claude/agents/qa-agent.md).
//
// Allow-list model, not deny-list — same shape as scraper-agent's hook
// (scripts/hooks/validate-scraper-agent.ts), because qa-agent's legitimate
// write/bash surface is just as narrow as scraper's, for the same reason:
// its entire job is auditing, not building. Its only legitimate Write/Edit
// target is .pipeline/qa-report.json, full stop — narrower than scraper's
// own allow-list, since qa-agent doesn't need a second cache-directory
// exception the way scraper does. Its only legitimate Bash use is
// start/stop-ing a local server via the shared scripts/server-lifecycle.ts
// utility, running scripts/a11y-audit.ts, and its own dry-run test.
//
// Usage (from hook config): bun scripts/hooks/validate-qa-agent.ts write|bash
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
  block("qa-agent hook: could not parse PreToolUse JSON payload from stdin");
}

// Deterministic key-sorted stringify so field-order differences never cause
// a false "content changed" positive in the terminal-status immutability
// check below.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type Finding = { id?: unknown; status?: unknown };
type Round = { round?: unknown; findings?: unknown };

function extractRounds(jsonText: string | null): Round[] | null {
  if (jsonText === null) return null;
  try {
    const parsed = JSON.parse(jsonText);
    const rounds = parsed?.data?.rounds;
    return Array.isArray(rounds) ? rounds : [];
  } catch {
    return null;
  }
}

const TERMINAL_STATUSES = new Set(["verified_fixed", "wont_fix", "superseded"]);

function withoutKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const clone = { ...obj };
  for (const key of keys) delete clone[key];
  return clone;
}

// The real hook boundary for qa-report.json, distinct from design/backend's
// round-immutability check because qa-agent's write pattern is genuinely
// different in shape (see qa-agent.md and the brainstorm that produced
// this): QA legitimately reaches back into PRIOR rounds every time it
// closes one out, so "current round only" would break its actual job.
// What's enforced instead:
//   1. Round-count/round-identity: unchanged from design/backend — rounds
//      never shrink, no round number disappears.
//   2. Finding-count-per-existing-round: within any round that already
//      existed, every finding id present before must still be present
//      after — the same append-only philosophy, one level deeper.
//   3. Terminal-status full-finding immutability: once a finding's status
//      is verified_fixed/wont_fix/superseded, NOT JUST its status but the
//      ENTIRE finding object is frozen — locking status alone would still
//      let a later write quietly rewrite severity/issue text on a closed
//      finding through a side door, corrupting the same audit record the
//      status lock was meant to protect. This is what makes "QA can't
//      un-ring its own bell" a mechanical guarantee, not just a convention
//      — including against qa-agent's own future writes, not just others'.
//   4. Non-current-round freeze: a round is "current" only if it holds the
//      highest round number present in the write. Any OTHER (i.e. already
//      closed-out) round is frozen except for the one legitimate thing
//      qa-agent still does to it later — reconciling a non-terminal
//      finding to a terminal status:
//        - no NEW finding may be appended to a non-current round (fresh
//          findings, including reopens, only ever belong in the current
//          round — see qa-agent.md step 6/7);
//        - round-level fields other than `findings` (acceptance_criteria_
//          check, scope, tested_at, round_result) are frozen entirely once
//          a round is no longer current;
//        - an existing non-terminal finding in a non-current round may
//          only have its `status` (and, since it's legitimately part of
//          the same reconciliation call, `agent_note`) change, and status
//          may only move to a terminal value — every other field is
//          frozen the same as if the finding were already terminal.
//      Reusing design/backend's plain "current round only" boundary here
//      would be wrong (see qa-agent.md) since QA's reconciliation writes
//      are inherently cross-round; this is the narrower, correct boundary.
function checkQaReportInvariants(oldContent: string | null, newContent: string | null): string | null {
  const oldRounds = extractRounds(oldContent);
  const newRounds = extractRounds(newContent);

  // Degrade to allowing when either side isn't determinable (unreadable
  // old file = first-ever write, nothing to protect; unparseable new
  // content = can't reliably check, and the schema/ajv validation step
  // downstream is the real backstop for shape correctness anyway).
  if (oldRounds === null || newRounds === null) return null;
  if (oldRounds.length === 0) return null;

  const oldRoundNumbers = new Set(oldRounds.map((r) => r.round).filter((n): n is number => typeof n === "number"));
  const newRoundNumbers = new Set(newRounds.map((r) => r.round).filter((n): n is number => typeof n === "number"));

  if (newRoundNumbers.size < oldRoundNumbers.size) {
    return `qa-report.json's round count may not decrease (had ${oldRoundNumbers.size}, would become ${newRoundNumbers.size}) — rounds are append-only`;
  }
  const missingRounds = [...oldRoundNumbers].filter((r) => !newRoundNumbers.has(r));
  if (missingRounds.length > 0) {
    return `round(s) ${missingRounds.join(", ")} would be removed from qa-report.json — rounds are append-only`;
  }

  const newRoundsByNumber = new Map<number, Round>();
  for (const r of newRounds) {
    if (typeof r.round === "number") newRoundsByNumber.set(r.round, r);
  }

  // "Current" = the highest round number present after this write. Every
  // other round in the file is, by definition, already closed out.
  const currentRoundNumber = newRoundNumbers.size > 0 ? Math.max(...newRoundNumbers) : null;

  for (const oldRound of oldRounds) {
    if (typeof oldRound.round !== "number") continue;
    const newRound = newRoundsByNumber.get(oldRound.round);
    if (!newRound) continue; // already reported above as a missing round

    const isCurrentRound = currentRoundNumber === null || oldRound.round === currentRoundNumber;

    const oldFindings = Array.isArray(oldRound.findings) ? (oldRound.findings as Finding[]) : [];
    const newFindings = Array.isArray(newRound.findings) ? (newRound.findings as Finding[]) : [];
    const newFindingsById = new Map<unknown, Finding>();
    for (const f of newFindings) newFindingsById.set(f.id, f);

    if (!isCurrentRound) {
      if (newFindings.length > oldFindings.length) {
        return `round ${oldRound.round} is no longer the current round (round ${currentRoundNumber} is) — new findings may only be added to the current round, not appended to a closed-out one`;
      }
      const oldRoundFrozen = stableStringify(withoutKeys(oldRound as Record<string, unknown>, ["findings"]));
      const newRoundFrozen = stableStringify(withoutKeys(newRound as Record<string, unknown>, ["findings"]));
      if (oldRoundFrozen !== newRoundFrozen) {
        return `round ${oldRound.round} is no longer current — its acceptance_criteria_check/scope/tested_at/round_result are frozen once a later round exists — blocked write to qa-report.json`;
      }
    }

    for (const oldFinding of oldFindings) {
      const newFinding = newFindingsById.get(oldFinding.id);
      if (!newFinding) {
        return `finding "${String(oldFinding.id)}" in round ${oldRound.round} would be removed from qa-report.json — findings within an existing round are append-only`;
      }
      if (typeof oldFinding.status === "string" && TERMINAL_STATUSES.has(oldFinding.status)) {
        if (stableStringify(oldFinding) !== stableStringify(newFinding)) {
          return `finding "${String(oldFinding.id)}" in round ${oldRound.round} is already terminal (status: "${oldFinding.status}") and may never be modified again, in any field — blocked write to qa-report.json`;
        }
      } else if (!isCurrentRound) {
        // Non-terminal finding in a closed-out round: the only legitimate
        // change left is qa-agent reconciling it to a terminal status,
        // optionally along with the agent_note explaining that call (e.g.
        // "confirmed fixed on re-test" / "not reproducible, wont_fix") —
        // agent_note is explicitly not QA-exclusive-only-on-write (design/
        // backend can also set it on their own findings, per spec.md), so
        // QA setting it here when finalizing a finding is legitimate, not a
        // side door. Every other field (issue/severity/category/page/etc.)
        // is still frozen.
        const oldWithoutStatus = stableStringify(withoutKeys(oldFinding as Record<string, unknown>, ["status", "agent_note"]));
        const newWithoutStatus = stableStringify(withoutKeys(newFinding as Record<string, unknown>, ["status", "agent_note"]));
        if (oldWithoutStatus !== newWithoutStatus) {
          return `finding "${String(oldFinding.id)}" in non-current round ${oldRound.round} may only have its status/agent_note fields change — every other field is frozen once its round is no longer current`;
        }
        if (
          oldFinding.status !== newFinding.status &&
          typeof newFinding.status === "string" &&
          !TERMINAL_STATUSES.has(newFinding.status)
        ) {
          return `finding "${String(oldFinding.id)}" in non-current round ${oldRound.round} may only transition to a terminal status (verified_fixed/wont_fix/superseded) during reconciliation — attempted "${newFinding.status}"`;
        }
      }
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

  const isQaReport = normalized === ".pipeline/qa-report.json" || normalized.endsWith("/.pipeline/qa-report.json");

  if (!isQaReport) {
    block(`qa-agent may only write ".pipeline/qa-report.json" — blocked write to "${rawPath}"`);
  }

  let oldContent: string | null;
  try {
    oldContent = readFileSync(rawPath, "utf-8");
  } catch {
    oldContent = null;
  }
  const newContent = computeNewContent(String(input.tool_name ?? ""), input.tool_input ?? {}, oldContent);

  const violation = checkQaReportInvariants(oldContent, newContent);
  if (violation) block(`qa-agent: ${violation}`);

  allow();
} else if (mode === "bash") {
  const command = String(input.tool_input?.command ?? "");

  // Same real bypass vectors as scraper-agent's hook: backtick and bare "$"
  // (command substitution / parameter expansion), plus newline.
  if (/[`$\n]/.test(command)) {
    block(`qa-agent Bash: command contains a backtick, "$", or newline — blocked "${command}"`);
  }

  const trimmed = command.trim();

  // server-lifecycle.ts start: --mode is a fixed enum, --cwd is a path with
  // no shell metacharacters (already ruled out above for the whole command).
  const isServerStart = /^bun scripts\/server-lifecycle\.ts start --mode (dev|build) --cwd \S+$/.test(trimmed);
  // stop takes NO target argument at all — it only ever kills the PID its
  // own pidfile recorded from the matching start. This is deliberately a
  // fixed, argument-less string: precision lives in server-lifecycle.ts's
  // own stop implementation, not in something this hook would have to
  // parse an attacker- or mistake-controlled PID out of.
  const isServerStop = trimmed === "bun scripts/server-lifecycle.ts stop";
  // a11y-audit.ts runs under node, not bun — a deliberate, live-verified
  // exception (see that script's own header comment: Bun's process/
  // WebSocket handling hangs against Playwright's driver on this machine,
  // Node doesn't). --url is restricted to http://localhost:<port>/... —
  // qa-agent audits the local server it just started, never an external
  // target, so a non-localhost URL here is always a mistake or worse.
  const isA11yAudit = /^node --experimental-strip-types scripts\/a11y-audit\.ts --url http:\/\/localhost:\d+\/\S* --tags [\w,]+$/.test(
    trimmed
  );
  const isValidationTest = trimmed === "bun test tests/agents/qa-output.dry-run.test.ts";
  // Playwright MCP's browser_take_screenshot resolves an explicit `filename`
  // against the MCP server's own process cwd (this repo's root) when one is
  // given, and never creates missing parent directories itself (confirmed by
  // reading playwright-core's workspaceFile()/_writeFile() directly — this
  // isn't inferred). Without this, a bare filename like "home.png" silently
  // lands loose at the repo root instead of inside the client's own
  // .pipeline/qa/screenshots/round-{n}/ — exactly the bug this allow-list
  // entry exists to let qa-agent fix for itself, by mkdir -p-ing that exact
  // destination before calling the screenshot tool. Client id restricted to
  // the same charset kickoff.json's client_id already uses; round is a plain
  // positive integer — no shell metacharacters possible in either.
  const isScreenshotDirSetup = /^mkdir -p clients\/[\w-]+\/\.pipeline\/qa\/screenshots\/round-\d+$/.test(trimmed);

  if (!isServerStart && !isServerStop && !isA11yAudit && !isValidationTest && !isScreenshotDirSetup) {
    block(
      `qa-agent Bash is restricted to "scripts/server-lifecycle.ts start|stop", "scripts/a11y-audit.ts", "mkdir -p clients/<id>/.pipeline/qa/screenshots/round-<n>", and the dry-run validation test — blocked "${trimmed}"`
    );
  }
  allow();
} else {
  block(`qa-agent hook: unknown mode "${mode}" (expected "write" or "bash")`);
}
