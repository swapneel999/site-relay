#!/usr/bin/env bun
// One-time, human-triggered onboarding step for a new client — NOT an
// agent, no PreToolUse hook, no Claude Code frontmatter. Run manually by
// whoever is setting up a new client, at the same time kickoff.json is
// authored (both are "human/intake, once" actions) and before design-agent
// ever runs, since design-agent needs a live --cwd site repo starting at
// design_homepage, the very first build stage.
//
// This exists specifically to close two gaps discovered while designing
// integration-lead-agent: (1) github-repo.ts's App-auth mechanism had no
// caller at all in an earlier draft of the five-agent pipeline, since
// integration-lead only verifies/promotes, never creates repos or
// projects — this script is the one that actually creates them, once,
// here, using that same mechanism; integration-lead separately calls
// github-repo.ts's `push` subcommand later, for the final QA-passed code,
// but never `verify-access` or repo creation, which stay exclusive to this
// script. (2) clients.json must be written at this moment, not at final
// signoff — a client's repo (and its deployed secrets, including the
// shared GOOGLE_PLACES_API_KEY) exists from the moment this script runs,
// which can be days or weeks before integration-lead ever sees this
// client. Registering only at signoff would leave every mid-build client
// invisible to the GOOGLE_PLACES_API_KEY rotation runbook
// (backend-agent.md) for the entire build duration.
//
// Prerequisites this script assumes already happened (manual, one-time,
// human steps — see .claude/agents/integration-lead-agent.md's own
// "Prerequisites" section for the full checklist):
//   - The agency's GitHub App is registered.
//   - The client has created one empty repo in their own GitHub account/org
//     (personal or org, either works — this script never calls a repo-
//     CREATION endpoint at all, see github-repo.ts's own header for why)
//     and installed the App scoped to just that repo.
//   - The client has created their own Vercel account/team and generated a
//     project-scoped VERCEL_TOKEN for the agency to use.
//
// Usage:
//   bun scripts/onboard-client.ts \
//     --client-id acme-co --name "Acme Co" \
//     --github-owner acme-co --github-repo acme-co-site --installation-id 12345678 \
//     --cwd path/to/local/scaffold \
//     --vercel-project-name acme-co-site \
//     [--dry-run]
//
// Requires GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY (for github-repo.ts) and
// VERCEL_TOKEN (for vercel-deploy.ts) in the environment — this script
// itself never reads or touches those values directly, it shells out to
// the two wrapper scripts that do.
//
// UNVERIFIED END-TO-END as of 2026-07-20 — depends entirely on
// github-repo.ts and vercel-deploy.ts, both themselves unverified against
// real accounts (see their own header comments for why, and what a real
// test requires). Do not run this against a real client until both of
// those have been live-tested.

export {};

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (key === "dry-run") {
        args[key] = "true";
        continue;
      }
      args[key] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const required = ["client-id", "name", "github-owner", "github-repo", "installation-id", "cwd", "vercel-project-name"];
for (const key of required) {
  if (!args[key]) fail(`--${key} is required`);
}
const dryRun = args["dry-run"] === "true";

function run(cmd: string[]): { ok: boolean; output: unknown } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) {
    fail(`Step failed (${cmd.join(" ")}): ${proc.stderr.toString()}`);
  }
  try {
    return { ok: true, output: JSON.parse(stdout) };
  } catch {
    return { ok: true, output: stdout };
  }
}

// Step 1: confirm the App installation can actually see the repo the client
// says they created — fail loud here rather than pushing into a repo that
// turns out not to be accessible.
const accessCheck = run([
  "bun",
  "scripts/github-repo.ts",
  "verify-access",
  "--owner",
  args["github-owner"],
  "--repo",
  args["github-repo"],
  "--installation-id",
  args["installation-id"],
]) as { ok: boolean; output: { access: boolean } };
if (!accessCheck.output.access) {
  fail(
    `GitHub App installation ${args["installation-id"]} cannot access ${args["github-owner"]}/${args["github-repo"]} — confirm the client created the repo and installed the App scoped to it before re-running.`
  );
}

// Step 2: push the initial scaffold.
const pushArgs = [
  "bun",
  "scripts/github-repo.ts",
  "push",
  "--owner",
  args["github-owner"],
  "--repo",
  args["github-repo"],
  "--installation-id",
  args["installation-id"],
  "--cwd",
  args.cwd,
];
if (dryRun) pushArgs.push("--dry-run");
run(pushArgs);

// Step 3: create the Vercel project, linked to the same repo for
// auto-deploy on push.
const createProjectArgs = [
  "bun",
  "scripts/vercel-deploy.ts",
  "create-project",
  "--name",
  args["vercel-project-name"],
  "--repo",
  `${args["github-owner"]}/${args["github-repo"]}`,
];
if (dryRun) createProjectArgs.push("--dry-run");
const projectResult = run(createProjectArgs) as { ok: boolean; output: { project_id?: string } };

// Step 4: register in clients.json — append-only, never overwrites an
// existing entry for this client_id.
const CLIENTS_JSON_PATH = join(import.meta.dir, "..", "clients.json");
const registry = JSON.parse(readFileSync(CLIENTS_JSON_PATH, "utf-8"));
if (registry.clients.some((c: { client_id: string }) => c.client_id === args["client-id"])) {
  fail(`clients.json already has an entry for client_id "${args["client-id"]}" — refusing to duplicate it.`);
}

const entry = {
  client_id: args["client-id"],
  name: args.name,
  repo_url: `https://github.com/${args["github-owner"]}/${args["github-repo"]}`,
  vercel_project_id: dryRun ? "dry-run-placeholder" : projectResult.output.project_id,
  github_installation_id: args["installation-id"],
  added_at: new Date().toISOString(),
  added_by: "onboard-client.ts",
};

if (dryRun) {
  console.log(JSON.stringify({ status: "dry_run", would_register: entry }));
} else {
  registry.clients.push(entry);
  writeFileSync(CLIENTS_JSON_PATH, JSON.stringify(registry, null, 2) + "\n");
  console.log(JSON.stringify({ status: "onboarded", entry }));
}
