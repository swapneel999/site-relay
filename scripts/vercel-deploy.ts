#!/usr/bin/env bun
// CLI wrapper around Vercel's REST API. `create-project` is used only by
// onboard-client.ts (one-time, at client onboarding). `env-list`,
// `check-preview`, `domain-check`, and `promote` are the subset
// integration-lead-agent is allow-listed to call — see that agent's Bash
// hook.
//
// Ownership model (see .claude/agents/integration-lead-agent.md): the
// client's own Vercel project, not an agency-wide team — the client
// generates a project-scoped token from their own account and provides it
// as VERCEL_TOKEN. Same blast-radius reasoning as GitHub's App-per-client
// model, actually stronger here: a compromised agency-wide Vercel
// credential can take every client's live site offline, not just leak code.
//
// Usage:
//   bun scripts/vercel-deploy.ts create-project --name <name> --repo <owner/repo> [--dry-run]
//   bun scripts/vercel-deploy.ts env-list --project <projectId>
//   bun scripts/vercel-deploy.ts check-preview --project <projectId>
//   bun scripts/vercel-deploy.ts domain-check --project <projectId> --domain <domain>
//   bun scripts/vercel-deploy.ts promote --project <projectId> --deployment <deploymentId> [--dry-run]
//
// Requires VERCEL_TOKEN in the environment (the client's own project-scoped
// token, read once here, never echoed/logged).
//
// Endpoint shapes below are sourced from Vercel's published REST API
// reference (not assumed from memory) as of 2026-07-20:
//   - POST /v11/projects                                  (create project, gitRepository-linked)
//   - GET  /v10/projects/{idOrName}/env                    (list env vars — keys only, decrypt not requested)
//   - GET  /v6/deployments?projectId=...&limit=1           (latest deployment, for check-preview/promote)
//   - GET  /v6/domains/{domain}/config?projectIdOrName=... (authoritative per-project domain check)
//   - POST /v10/projects/{projectId}/promote/{deploymentId} (promote to production)
// See this project's own research trail for sources; if any of these have
// moved to a newer version by the time this runs for real, that's exactly
// what the live-testing requirement below exists to catch.
//
// domain-check REPLACES an earlier standalone scripts/dns-check.ts that did
// its own raw DNS resolution against a caller-supplied "expected target" —
// removed because that design was wrong, not just unverified: Vercel's own
// documentation states each project gets a UNIQUE per-project CNAME target
// (e.g. d1d4fc829fe7bc7c.vercel-dns-017.com), so a single hardcoded
// "expected target" string would have been incorrect for most real
// domains. Vercel's own /v6/domains/{domain}/config endpoint already knows
// the correct per-project target and returns a plain `verified` boolean —
// strictly more correct than re-deriving that comparison client-side, and
// removes the "where does --expected-target come from" ambiguity entirely.
//
// UNVERIFIED AGAINST A REAL VERCEL ACCOUNT as of 2026-07-20 — no
// VERCEL_TOKEN exists in this environment, so none of the calls below have
// actually been exercised. Same honest-unverified treatment as
// github-repo.ts and, before it, a11y-audit.ts: these shapes match Vercel's
// documented API, "matches the docs" is not this project's bar for done.
// Live-test against a real (sandbox) Vercel account before the first real
// client, and update this comment with the date once that happens.

export {};

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

const TOKEN = process.env.VERCEL_TOKEN;
if (!TOKEN) fail("VERCEL_TOKEN is not set in the environment.");

async function vercelFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

async function createProject(name: string, repo: string, dryRun: boolean): Promise<void> {
  const body = { name, gitRepository: { repo, type: "github" } };
  if (dryRun) {
    console.log(JSON.stringify({ status: "dry_run", would_create: body }));
    return;
  }
  const res = await vercelFetch("/v11/projects", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) fail(`Vercel create-project failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { id: string; name: string };
  console.log(JSON.stringify({ status: "created", project_id: json.id, name: json.name }));
}

async function envList(project: string): Promise<void> {
  const res = await vercelFetch(`/v10/projects/${encodeURIComponent(project)}/env?decrypt=false`);
  if (!res.ok) fail(`Vercel env-list failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { envs: Array<{ key: string; target: string[] }> };
  // Keys only, deliberately — this checklist item confirms required env vars
  // EXIST on the target project, never their values. decrypt=false above is
  // the same intent enforced at the request layer, not just by convention.
  const keys = (json.envs ?? []).map((e) => e.key);
  console.log(JSON.stringify({ project, configured_keys: keys }));
}

async function latestDeployment(project: string): Promise<{ uid: string; url: string; readyState: string } | null> {
  const res = await vercelFetch(`/v6/deployments?projectId=${encodeURIComponent(project)}&limit=1`);
  if (!res.ok) fail(`Vercel list-deployments failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { deployments: Array<{ uid: string; url: string; readyState: string }> };
  return json.deployments?.[0] ?? null;
}

async function checkPreview(project: string): Promise<void> {
  const deployment = await latestDeployment(project);
  if (!deployment) {
    console.log(JSON.stringify({ project, live: false, reason: "no deployments found" }));
    return;
  }
  const url = `https://${deployment.url}`;
  let live = deployment.readyState === "READY";
  if (live) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      live = res.ok;
    } catch {
      live = false;
    }
  }
  console.log(JSON.stringify({ project, live, url, deployment_id: deployment.uid, ready_state: deployment.readyState }));
}

async function domainCheck(project: string, domain: string): Promise<void> {
  const res = await vercelFetch(`/v6/domains/${encodeURIComponent(domain)}/config?projectIdOrName=${encodeURIComponent(project)}`);
  if (!res.ok) fail(`Vercel domain-check failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    verified?: boolean;
    configuredBy?: string | null;
    recommendedCNAME?: string[];
    recommendedIPv4?: string[];
  };
  console.log(
    JSON.stringify({
      domain,
      project,
      configured: json.verified === true,
      configured_by: json.configuredBy ?? null,
      recommended_cname: json.recommendedCNAME ?? [],
      recommended_ipv4: json.recommendedIPv4 ?? [],
    })
  );
}

async function promote(project: string, deployment: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(JSON.stringify({ status: "dry_run", would_promote: { project, deployment } }));
    return;
  }
  const res = await vercelFetch(`/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(deployment)}`, {
    method: "POST",
  });
  if (!res.ok) fail(`Vercel promote failed: HTTP ${res.status} ${await res.text()}`);
  console.log(JSON.stringify({ status: "promoted", project, deployment }));
}

const [, , command] = process.argv;
const args = parseArgs(process.argv.slice(3));

if (command === "create-project") {
  if (!args.name || !args.repo) fail("create-project requires --name and --repo");
  await createProject(args.name, args.repo, args["dry-run"] === "true");
} else if (command === "env-list") {
  if (!args.project) fail("env-list requires --project");
  await envList(args.project);
} else if (command === "check-preview") {
  if (!args.project) fail("check-preview requires --project");
  await checkPreview(args.project);
} else if (command === "domain-check") {
  if (!args.project || !args.domain) fail("domain-check requires --project and --domain");
  await domainCheck(args.project, args.domain);
} else if (command === "promote") {
  if (!args.project || !args.deployment) fail("promote requires --project and --deployment");
  await promote(args.project, args.deployment, args["dry-run"] === "true");
} else {
  fail(`Unknown command "${command}". Use "create-project", "env-list", "check-preview", "domain-check", or "promote".`);
}
