import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "hooks", "validate-backend-agent.ts");

async function runHook(payload: unknown): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT], {
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

describe("scripts/hooks/validate-backend-agent.ts", () => {
  test("writing arbitrary site code is allowed", async () => {
    const { exitCode } = await runHook({ tool_input: { file_path: "C:/clients/acme/app/api/checkout/route.ts" } });
    expect(exitCode).toBe(0);
  });

  test("writing mockup-approval.json is allowed (field-level rules are prompt-enforced, not hook-enforced)", async () => {
    const { exitCode } = await runHook({ tool_input: { file_path: ".pipeline/mockup-approval.json" } });
    expect(exitCode).toBe(0);
  });

  test("writing qa-report.json is allowed (field-level rules are prompt-enforced, not hook-enforced)", async () => {
    const { exitCode } = await runHook({ tool_input: { file_path: ".pipeline/qa-report.json" } });
    expect(exitCode).toBe(0);
  });

  for (const file of ["kickoff.json", "scraper-output.json", "signoff.json", "pipeline-status.json", "design-lock.json"]) {
    test(`writing ${file} (relative) is blocked`, async () => {
      const { exitCode, stderr } = await runHook({ tool_input: { file_path: `.pipeline/${file}` } });
      expect(exitCode).toBe(2);
      expect(stderr).toContain(file);
    });

    test(`writing ${file} (absolute) is blocked`, async () => {
      const { exitCode } = await runHook({
        tool_input: { file_path: `C:/clients/acme/.pipeline/${file}` },
      });
      expect(exitCode).toBe(2);
    });

    test(`writing ${file} disguised via ".." traversal is blocked`, async () => {
      const { exitCode } = await runHook({
        tool_input: { file_path: `.pipeline/scraper-cache/../${file}` },
      });
      expect(exitCode).toBe(2);
    });
  }

  test("writing design-lock.json is blocked (unlike design-agent, this file is off-limits to backend-agent)", async () => {
    const { exitCode, stderr } = await runHook({ tool_input: { file_path: ".pipeline/design-lock.json" } });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("design agent");
  });

  test("unparseable stdin fails closed (blocked), not open", async () => {
    const proc = Bun.spawn(["bun", SCRIPT], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write("not json");
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);
  });

  test('case-insensitive match: ".PIPELINE/Kickoff.json" is blocked same as the lowercase form', async () => {
    const { exitCode, stderr } = await runHook({ tool_input: { file_path: ".PIPELINE/Kickoff.json" } });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("kickoff.json");
  });

  test('case-insensitive match: mixed-case absolute path to DESIGN-LOCK.JSON is blocked', async () => {
    const { exitCode } = await runHook({ tool_input: { file_path: "C:/Clients/Acme/.PIPELINE/DESIGN-LOCK.JSON" } });
    expect(exitCode).toBe(2);
  });
});

function makeRoundsFile(path: string, rounds: number[]) {
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "2026-07-03T00:00:00Z",
      last_updated_by: "orchestrator",
      data: {
        status: "changes_requested",
        current_round: rounds.length,
        rounds: rounds.map((r) => ({
          round: r,
          mockup_ref: `round-${r}.png`,
          submitted_at: "2026-07-03T00:00:00Z",
          feedback_items: [],
          decided_at: null,
          decided_status: null,
        })),
      },
    })
  );
}

describe("scripts/hooks/validate-backend-agent.ts — round-immutability check", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "backend-agent-hook-test-"));
    filePath = join(dir, "mockup-approval.json").replace(/\\/g, "/");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("Write with a superset of existing rounds is allowed", async () => {
    makeRoundsFile(filePath, [1, 2]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "backend-agent",
      data: {
        status: "changes_requested",
        current_round: 3,
        rounds: [1, 2, 3].map((r) => ({
          round: r,
          mockup_ref: `round-${r}.png`,
          submitted_at: "2026-07-03T00:00:00Z",
          feedback_items: [],
          decided_at: null,
          decided_status: null,
        })),
      },
    });
    const { exitCode } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(0);
  });

  test("Write that drops an existing round (net count also shrinks) is blocked on the count check", async () => {
    makeRoundsFile(filePath, [1, 2]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "backend-agent",
      data: {
        status: "changes_requested",
        current_round: 1,
        rounds: [
          {
            round: 2,
            mockup_ref: "round-2.png",
            submitted_at: "2026-07-03T00:00:00Z",
            feedback_items: [],
            decided_at: null,
            decided_status: null,
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("may not decrease");
  });

  test("Write that swaps an existing round for a new one (same count) is blocked on the missing-round check", async () => {
    makeRoundsFile(filePath, [1, 2]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "backend-agent",
      data: {
        status: "changes_requested",
        current_round: 2,
        rounds: [
          {
            round: 2,
            mockup_ref: "round-2.png",
            submitted_at: "2026-07-03T00:00:00Z",
            feedback_items: [],
            decided_at: null,
            decided_status: null,
          },
          {
            round: 3,
            mockup_ref: "round-3.png",
            submitted_at: "2026-07-03T00:00:00Z",
            feedback_items: [],
            decided_at: null,
            decided_status: null,
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("round(s) 1");
  });

  test("Write with fewer total rounds (even if renumbered) is blocked", async () => {
    makeRoundsFile(filePath, [1, 2, 3]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "backend-agent",
      data: { status: "changes_requested", current_round: 2, rounds: [{ round: 1 }, { round: 2 }] },
    });
    const { exitCode } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
  });

  test("first-ever write (file doesn't exist yet) is allowed", async () => {
    const freshPath = join(dir, "qa-report.json").replace(/\\/g, "/");
    const content = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "qa-agent",
      data: { overall_status: "fail", current_round: 1, rounds: [{ round: 1 }] },
    });
    const { exitCode } = await runHook({ tool_name: "Write", tool_input: { file_path: freshPath, content } });
    expect(exitCode).toBe(0);
  });

  test("Edit that only touches status/agent_note (rounds untouched) is allowed", async () => {
    makeRoundsFile(filePath, [1, 2]);
    const { exitCode } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: '"decided_status":null}]', new_string: '"decided_status":"approved"}]' },
    });
    expect(exitCode).toBe(0);
  });
});
