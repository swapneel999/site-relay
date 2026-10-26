#!/usr/bin/env bun
// CLI wrapper around GitHub App authentication, so onboard-client.ts and
// integration-lead-agent can verify access to / push into a client's own
// GitHub repo without the App's private key ever passing through agent
// context. Same pattern as places-lookup.ts: secret read once from this
// process's env, never echoed/logged.
//
// Two callers: onboard-client.ts uses `verify-access` then `push` once, at
// onboarding, to land the initial scaffold. integration-lead-agent uses
// only `push` — again, later, at integration_signoff — to land the final,
// QA-passed code right before its checklist/promotion flow. Both are
// legitimate `push` callers, at different points, for different content;
// only `verify-access` is onboarding-exclusive (integration-lead-agent's
// hook doesn't allow-list it — there's nothing to re-verify that
// onboarding didn't already confirm once).
//
// See .claude/agents/integration-lead-agent.md's "Assumption" section for
// why the FINAL push happens there and not incrementally in
// design-agent/backend-agent: none of design/backend/QA's own testing
// needs a push at all (they all test against a LOCAL dev/build server via
// server-lifecycle.ts), so consolidating the one real push-to-production-
// source-of-truth action in the one agent that already has the narrowest,
// most tightly-scoped Bash surface in this pipeline is a smaller blast
// radius than granting GitHub credentials to design/backend too.
//
// Ownership model (see .claude/agents/integration-lead-agent.md and the
// brainstorm that produced it): the client's repo is client-owned, created
// under the client's own GitHub account/org, not an agency-owned org. The
// agency's GitHub App is installed on the client's account, scoped to
// exactly one repo, and is independently revocable by the client at any
// time without agency involvement.
//
// DELIBERATE SCOPE LIMIT, discovered via research (not assumed from docs
// alone) before writing this: GitHub Apps cannot create repositories in a
// PERSONAL user account via an installation token at all — this is a hard
// API restriction, not a permission you can grant your way around (org-
// owned repos work fine; see the GitHub community discussions linked in
// this project's own design notes). Rather than force clients onto an org
// just to make App-driven creation work, this script never creates a repo
// at all: the client (or whoever walks them through the App-install consent
// screen) creates one empty repo first — a small addition to a step that's
// already manual — then installs the App scoped to just that repo. This
// script only ever VERIFIES the installation can see that repo and PUSHES
// into it. That's a smaller, safer surface than create+push, not a bigger
// one, and it works identically whether the client used a personal account
// or an org.
//
// Usage:
//   bun scripts/github-repo.ts verify-access --owner <owner> --repo <repo> --installation-id <id>
//   bun scripts/github-repo.ts push --owner <owner> --repo <repo> --installation-id <id> --cwd <path> [--branch main] [--dry-run]
//
// Requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (PEM, agency-wide
// secrets identifying the App itself) in the environment. --installation-id
// is per-client and not secret (visible in the App's own installation
// settings), so it's a CLI arg, not an env var.
//
// CREDENTIAL-EXPOSURE FIX (2026-07-20): push() no longer calls `git remote
// set-url` with a token embedded in the URL (persisted the token to
// .git/config on disk indefinitely, well past its ~1hr expiry) and no
// longer passes a token-embedded URL as a literal argv argument (visible
// to any other process on the machine that can read this process's
// argument list while git runs). The Authorization header is now supplied
// via GIT_CONFIG_* environment variables instead — see push()'s own
// comment. This is a code-correctness fix, independent of the
// account-verification gap below.
//
// UNVERIFIED AGAINST A REAL INSTALLATION as of 2026-07-20 — there is no
// GitHub App registered yet and no installation to test against in this
// environment (confirmed: no GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY set).
// Per this project's own live-testing standard (the generate-image.ts and
// a11y-audit.ts precedent), this should NOT be trusted as done until it's
// actually been run against a real GitHub App installation — the JWT-
// signing and installation-token-exchange shapes below match GitHub's
// documented API, but "matches the docs" is exactly the standard that
// failed once already in this project (generate-image.ts's image/png vs
// image/jpeg incident). Run a real end-to-end test (register a throwaway
// App, install it on a personal sandbox account against one throwaway
// repo, verify-access, then push) before the first real client onboarding,
// and update this comment with the date once that happens.

export {};

import { createSign } from "node:crypto";

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

const APP_ID = process.env.GITHUB_APP_ID;
const PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;

if (!APP_ID || !PRIVATE_KEY) {
  fail("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must both be set in the environment.");
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

// Mints a short-lived (10 minute max, per GitHub's own limit) JWT identifying
// the App itself — this is the credential used ONLY to exchange for a
// scoped, even-shorter-lived installation access token below. Never used
// directly against the repo API.
function mintAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: APP_ID };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(PRIVATE_KEY!).toString("base64url");
  return `${signingInput}.${signature}`;
}

// Exchanges the App JWT for an installation access token scoped to exactly
// this one client's installation — this is the credential that actually
// touches the repo API, and it expires in ~1 hour per GitHub's own default.
async function getInstallationToken(installationId: string): Promise<string> {
  const jwt = mintAppJwt();
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    fail(`Failed to mint installation access token: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token: string };
  return json.token;
}

// Scrubs a live token out of any text before it's ever printed — git's own
// error output can echo back a remote URL verbatim on failure, and that URL
// embeds the token as the HTTPS credential (see push() below). A short-lived
// installation token is lower-severity than a permanent PAT, but there's no
// reason to ever let it hit a log/terminal when it's this easy not to.
function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join("<redacted-token>") : text;
}

async function verifyAccess(owner: string, repo: string, installationId: string): Promise<void> {
  const token = await getInstallationToken(installationId);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
  });
  console.log(JSON.stringify({ owner, repo, access: res.ok, status: res.status }));
}

async function push(owner: string, repo: string, installationId: string, cwd: string, branch: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(
      JSON.stringify({
        status: "dry_run",
        would_push: { owner, repo, branch, cwd },
      })
    );
    return;
  }

  // Minted only past this point — dry-run makes no live calls at all, same
  // as vercel-deploy.ts's createProject/promote.
  const token = await getInstallationToken(installationId);

  // Origin is a PLAIN, credential-free URL — safe to persist to
  // .git/config on disk, unlike the token itself. Set (or re-set) it
  // unconditionally rather than assuming it's already correct.
  const plainRemoteUrl = `https://github.com/${owner}/${repo}.git`;
  const setRemote = Bun.spawnSync(["git", "-C", cwd, "remote", "set-url", "origin", plainRemoteUrl], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (setRemote.exitCode !== 0) {
    // Most likely cause: origin doesn't exist yet on a fresh scaffold.
    const addRemote = Bun.spawnSync(["git", "-C", cwd, "remote", "add", "origin", plainRemoteUrl], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (addRemote.exitCode !== 0) {
      fail(`Failed to configure origin remote: ${addRemote.stderr.toString()}`);
    }
  }

  // The token itself never touches disk or argv. Both prior approaches had
  // a real exposure path: embedding it in the remote URL persists it to
  // .git/config indefinitely (well past the token's ~1hr expiry), and
  // passing a token-embedded URL as a literal argv argument makes it
  // visible to any other process on the machine that can read this
  // process's argument list while git runs. Instead, the Authorization
  // header is supplied via GIT_CONFIG_* environment variables — git reads
  // these for exactly this one invocation, and they live only in this
  // child process's environment, never on disk, never in argv. Same
  // never-in-argv, never-on-disk posture as every other secret in this
  // project (places-lookup.ts, generate-image.ts): read once, used once,
  // never persisted or echoed.
  const basicAuth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const pushResult = Bun.spawnSync(["git", "-C", cwd, "push", "origin", branch], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth}`,
    },
  });
  if (pushResult.exitCode !== 0) {
    fail(scrub(`git push failed: ${pushResult.stderr.toString()}`, token));
  }

  console.log(JSON.stringify({ status: "pushed", owner, repo, branch }));
}

const [, , command] = process.argv;
const args = parseArgs(process.argv.slice(3));

if (command === "verify-access") {
  if (!args.owner || !args.repo || !args["installation-id"]) {
    fail("verify-access requires --owner, --repo, and --installation-id");
  }
  await verifyAccess(args.owner, args.repo, args["installation-id"]);
} else if (command === "push") {
  if (!args.owner || !args.repo || !args["installation-id"] || !args.cwd) {
    fail("push requires --owner, --repo, --installation-id, and --cwd");
  }
  await push(args.owner, args.repo, args["installation-id"], args.cwd, args.branch || "main", args["dry-run"] === "true");
} else {
  fail(`Unknown command "${command}". Use "verify-access --owner <o> --repo <r> --installation-id <id>" or "push --owner <o> --repo <r> --installation-id <id> --cwd <path> [--branch <b>] [--dry-run]".`);
}
