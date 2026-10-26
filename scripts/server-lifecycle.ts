#!/usr/bin/env bun
// Shared "start a local site server, wait until it's actually serving,
// guarantee cleanup" utility — used by BOTH design-agent (screenshot
// capture, --mode dev) and qa-agent (adversarial audit, --mode build)
// rather than each agent reimplementing its own version that will
// inevitably drift. This also closes a real gap in design-agent's
// original screenshot-capture instructions: "start the dev server... stop
// it before finishing" had no guaranteed-cleanup mechanism, so an agent
// that errored mid-run (or a bug in its own flow) could leave a dev server
// orphaned indefinitely. This script fixes that by:
//   - standardizing on a single known port (3000) and a single global
//     pidfile slot, consistent with this pipeline's already-established
//     strictly-sequential concurrency model (docs/spec.md) — only one
//     agent, and therefore only one local server, is ever active at a time
//   - killing anything already bound to that port before starting (guards
//     against an orphan from a previous crashed run, independent of
//     whether this run's own pidfile survived)
//   - writing the actual spawned PID to that pidfile only once the server
//     is CONFIRMED serving, and cleaning up its own spawn if it never
//     reaches that point (no leaked process on a failed start)
//   - a `stop` subcommand that takes NO target argument at all — it only
//     ever kills the exact PID recorded by the most recent successful
//     `start`, read from the pidfile. This is deliberate: the Bash
//     allow-list hooks that gate design-agent/qa-agent only need to permit
//     the fixed strings "start"/"stop" (plus --mode/--cwd on start), never
//     a raw taskkill/kill/pkill invocation with an attacker- or
//     mistake-controlled PID. Precision lives in this script, not in what
//     the hook has to parse out of an arbitrary shell command.
//
// Usage:
//   bun scripts/server-lifecycle.ts start --mode dev   --cwd path/to/site
//   bun scripts/server-lifecycle.ts start --mode build --cwd path/to/site
//   bun scripts/server-lifecycle.ts stop
//
// --mode dev:   spawns `bun run dev` directly, then polls until serving.
// --mode build: runs `bun run build` synchronously first (fails loudly on
//               a non-zero exit, nothing left running), then spawns
//               `bun run start` and polls until serving. Used by qa-agent,
//               which must audit an actual production build, never dev
//               mode's fast-refresh/dev-only code paths.

export {};

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 3000;
const STATE_DIR = join(tmpdir(), "site-relay-server-lifecycle");
const PIDFILE = join(STATE_DIR, "server.pid");

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

// --- Port occupancy: best-effort lookup + kill, used only as a pre-start
// safety net for orphans from a previous crashed run whose pidfile is
// missing or stale. Never exposed to the hook as its own allow-listed
// command — it's an internal step of `start`, not a separate primitive an
// agent can invoke with an arbitrary target.
function findPidOnPort(port: number): string | null {
  try {
    if (isWindows()) {
      // No shell/findstr here deliberately: `findstr :${port}` is an
      // UNANCHORED substring match, so `:3000` also matches `:30000`,
      // `:13000`, `:23000`, etc. — a real bug, not a style nit, since it
      // would hand killPid() the wrong PID and silently kill an unrelated
      // process on the machine. Parsed directly instead: the local-address
      // column must end with exactly `:${port}`, anchored, mirroring the
      // precision lsof's `-ti tcp:${port}` already has on the POSIX branch.
      const out = Bun.spawnSync(["netstat", "-ano", "-p", "tcp"]).stdout.toString();
      const portSuffix = new RegExp(`:${port}$`);
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [, localAddress, , state, pid] = parts;
        if (state !== "LISTENING") continue;
        if (!portSuffix.test(localAddress)) continue;
        return pid || null;
      }
      return null;
    } else {
      const out = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`]).stdout.toString().trim();
      return out.split("\n")[0] || null;
    }
  } catch {
    return null; // best-effort — absence of lsof/netstat shouldn't crash start
  }
}

// Tree-kill by PID — used both for the port-occupancy safety net and for
// the pidfile-anchored `stop` subcommand. Honest limit: on POSIX, if the
// recorded PID is a shell wrapper (e.g. `bun run start` spawning a node
// child), `/T`-equivalent tree termination isn't guaranteed the way
// Windows' `taskkill /T` guarantees it — this is a best-effort kill of the
// recorded PID plus its direct children, not a perfect process-group
// sandbox. Documented rather than silently assumed complete.
function killPid(pid: string): void {
  try {
    if (isWindows()) {
      Bun.spawnSync(["taskkill", "/PID", pid, "/T", "/F"]);
    } else {
      try {
        const children = Bun.spawnSync(["pgrep", "-P", pid]).stdout.toString().trim();
        for (const childPid of children.split("\n").filter(Boolean)) {
          try {
            process.kill(Number(childPid), "SIGKILL");
          } catch {
            /* child may already be gone */
          }
        }
      } catch {
        /* pgrep unavailable — proceed with just the parent */
      }
      process.kill(Number(pid), "SIGKILL");
    }
  } catch {
    /* already dead — nothing to do */
  }
}

async function waitUntilServing(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true; // any non-server-error response means something is actually listening and answering
    } catch {
      /* not serving yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function start(mode: string, cwd: string): Promise<void> {
  if (mode !== "dev" && mode !== "build") fail(`--mode must be "dev" or "build", got "${mode}"`);
  if (!cwd) fail("--cwd (path to the site repo) is required");

  mkdirSync(STATE_DIR, { recursive: true });

  // Clean up a stale PID from a previous run's pidfile, if any.
  if (existsSync(PIDFILE)) {
    const stalePid = readFileSync(PIDFILE, "utf-8").trim();
    if (stalePid) killPid(stalePid);
    unlinkSync(PIDFILE);
  }
  // Belt-and-suspenders: kill anything else bound to the port even if no
  // pidfile survived (e.g. a run that crashed before ever writing one).
  const strayPid = findPidOnPort(PORT);
  if (strayPid) killPid(strayPid);

  if (mode === "build") {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) {
      fail(`"bun run build" failed (exit ${build.exitCode}) in ${cwd}:\n${build.stderr.toString()}`);
    }
  }

  // VERIFIED live on 2026-07-20: `bun run <script> --port 3000` really does
  // forward `["--port", "3000"]` onto the underlying command's own argv
  // (confirmed against a scratch package.json script) — not swallowed by
  // bun, not merged into a single string. This is what next dev/next start
  // expect, so the passthrough below works as written.
  const runScript = mode === "build" ? "start" : "dev";
  const proc = Bun.spawn(["bun", "run", runScript, "--port", String(PORT)], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();

  const serving = await waitUntilServing(30_000);
  if (!serving) {
    killPid(String(proc.pid));
    fail(`Server did not respond on http://localhost:${PORT}/ within 30s (mode: ${mode}, cwd: ${cwd}) — killed the spawned process, nothing left running.`);
  }

  writeFileSync(PIDFILE, String(proc.pid));
  console.log(JSON.stringify({ status: "serving", url: `http://localhost:${PORT}/`, pid: proc.pid, mode }));
}

function stop(): void {
  if (!existsSync(PIDFILE)) {
    console.log(JSON.stringify({ status: "already_stopped" }));
    return;
  }
  const pid = readFileSync(PIDFILE, "utf-8").trim();
  if (pid) killPid(pid);
  unlinkSync(PIDFILE);
  console.log(JSON.stringify({ status: "stopped", pid }));
}

const [, , command] = process.argv;
const args = parseArgs(process.argv.slice(3));

if (command === "start") {
  await start(args.mode, args.cwd);
} else if (command === "stop") {
  stop();
} else {
  fail(`Unknown command "${command}". Use "start --mode dev|build --cwd <path>" or "stop".`);
}
