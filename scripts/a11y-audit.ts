#!/usr/bin/env -S node --experimental-strip-types
// CLI wrapper around @axe-core/playwright ("AxeBuilder"), so qa-agent can
// run a real accessibility scan via Bash without needing raw Playwright
// `Page` access — @playwright/mcp (the MCP server qa-agent/design-agent use
// for interactive navigation/screenshots) doesn't expose a Page handle to
// arbitrary library code, so AxeBuilder can't run through the MCP the way
// navigation/screenshots do. This script launches its own isolated headless
// Chromium instance instead, separate from any MCP-driven session.
//
// Usage:
//   node --experimental-strip-types scripts/a11y-audit.ts --url http://localhost:3000/about --tags wcag2a,wcag2aa,wcag21aa
//
// Tags should match kickoff.json's constraints.compliance.accessibility_level:
//   AA  -> wcag2a,wcag2aa,wcag21aa
//   AAA -> wcag2a,wcag2aa,wcag21aa,wcag2aaa,wcag21aaa
//   none -> don't invoke this script at all (qa-agent skips this step entirely)
//
// RUNS UNDER NODE, NOT BUN — the one deliberate exception to this repo's
// "bun runs .ts files directly" convention (see CLAUDE.md), and it's here
// for a verified reason, not a style preference. Live-tested on 2026-07-20:
//   - `bun`: `chromium.launch()` hangs and times out (`TimeoutError: launch:
//     Timeout ...ms exceeded`) on this machine, on this Bun version
//     (1.3.14) — reproduced with Chromium AND Firefox, across
//     --no-sandbox/--disable-gpu/legacy-headless flags.
//   - Ruled out as a browser-install problem: the actual chrome.exe /
//     chrome-headless-shell.exe binaries run fine standalone (`--version`
//     returns instantly) and respond correctly over a real CDP TCP port
//     when spawned directly and queried with curl.
//   - Ruled out as a "just use connectOverCDP instead of the default pipe
//     transport" fix: manually spawning the browser with
//     --remote-debugging-port and attaching via
//     `chromium.connectOverCDP(...)` ALSO hangs under Bun, even though the
//     same CDP endpoint answers curl instantly. So this isn't specific to
//     Playwright's pipe-fd transport — Bun's process/WebSocket handling is
//     incompatible with Playwright's driver more broadly, at least on this
//     version pairing.
//   - `node` (22.14.0, with --experimental-strip-types to run this .ts file
//     directly): `chromium.launch()` succeeds in ~176ms. Full run against a
//     live local page (chromium.launch() -> browser.newContext() ->
//     context.newPage() -> page.goto() -> AxeBuilder(...).analyze())
//     completed successfully end to end and returned real violations.
// If qa-agent's actual execution environment ever moves to a Bun version
// where this is fixed, this can move back to `bun` — but re-verify with the
// same connectOverCDP test above before doing so, don't just assume a Bun
// version bump fixed it.
//
// Also fixed by that live run: AxeBuilder rejects a `page` created via the
// `browser.newPage()` shorthand ("Please use browser.newContext()") — it
// needs a page from an explicit context, hence the context.close()/
// browser.close() pairing below instead of just browser.close().

export {};

import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

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

const args = parseArgs(process.argv.slice(2));
if (!args.url) fail("--url is required");
if (!args.tags) fail("--tags is required (comma-separated axe-core WCAG tags, e.g. wcag2a,wcag2aa,wcag21aa)");

const tags = args.tags.split(",").map((t) => t.trim()).filter(Boolean);

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const res = await page.goto(args.url, { waitUntil: "networkidle" });
  if (!res || !res.ok()) {
    fail(`Failed to load ${args.url}: HTTP ${res?.status() ?? "no response"}`);
  }

  const results = await new AxeBuilder({ page }).withTags(tags).analyze();

  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? "unknown",
    description: v.description,
    help_url: v.helpUrl,
    tags: v.tags,
    nodes: v.nodes.map((n) => ({ target: n.target, html: n.html, failure_summary: n.failureSummary })),
  }));

  console.log(JSON.stringify({ url: args.url, tags, violation_count: violations.length, violations }));
  await context.close();
} finally {
  await browser.close();
}
