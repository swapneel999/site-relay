import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "hooks", "validate-scraper-agent.ts");

async function runHook(
  mode: "write" | "bash",
  payload: unknown
): Promise<{ exitCode: number; stderr: string }> {
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

describe("scripts/hooks/validate-scraper-agent.ts — bash mode", () => {
  test("business name containing & is allowed (not a bypass vector)", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: 'bun scripts/places-lookup.ts search --query "Smith & Sons Plumbing, Denver, CO"' },
    });
    expect(exitCode).toBe(0);
  });

  test("$(...) injection inside the query is blocked", async () => {
    const { exitCode, stderr } = await runHook("bash", {
      tool_input: { command: 'bun scripts/places-lookup.ts search --query "$(rm -rf /)"' },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("$(");
  });

  test("backtick injection inside the query is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: 'bun scripts/places-lookup.ts search --query "`rm -rf /`"' },
    });
    expect(exitCode).toBe(2);
  });

  test("${VAR} parameter expansion inside the query is blocked", async () => {
    const { exitCode, stderr } = await runHook("bash", {
      tool_input: { command: 'bun scripts/places-lookup.ts search --query "${GOOGLE_PLACES_API_KEY}"' },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("$");
  });

  test("bare $VAR parameter expansion inside the query is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: 'bun scripts/places-lookup.ts search --query "$GOOGLE_PLACES_API_KEY"' },
    });
    expect(exitCode).toBe(2);
  });

  test("semicolon-appended command after a valid prefix is blocked", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: 'bun scripts/places-lookup.ts search --query "x"; rm -rf /' },
    });
    expect(exitCode).toBe(2);
  });

  test("valid places-lookup search command is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: 'bun scripts/places-lookup.ts search --query "Acme Plumbing, Denver, CO"' },
    });
    expect(exitCode).toBe(0);
  });

  test("valid places-lookup details command is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun scripts/places-lookup.ts details --place-id ChIJabc123" },
    });
    expect(exitCode).toBe(0);
  });

  test("valid dry-run validation test command is allowed", async () => {
    const { exitCode } = await runHook("bash", {
      tool_input: { command: "bun test tests/agents/scraper-output.dry-run.test.ts" },
    });
    expect(exitCode).toBe(0);
  });

  test("an arbitrary disallowed command is blocked", async () => {
    const { exitCode } = await runHook("bash", { tool_input: { command: "rm -rf /" } });
    expect(exitCode).toBe(2);
  });
});

describe("scripts/hooks/validate-scraper-agent.ts — write mode", () => {
  test("relative-path write to .pipeline/scraper-output.json is allowed", async () => {
    const { exitCode } = await runHook("write", {
      tool_input: { file_path: ".pipeline/scraper-output.json" },
    });
    expect(exitCode).toBe(0);
  });

  test("absolute-path write to .pipeline/scraper-output.json is allowed", async () => {
    const { exitCode } = await runHook("write", {
      tool_input: { file_path: "C:/clients/acme/.pipeline/scraper-output.json" },
    });
    expect(exitCode).toBe(0);
  });

  test("relative-path write under .pipeline/scraper-cache/ is allowed", async () => {
    const { exitCode } = await runHook("write", {
      tool_input: { file_path: ".pipeline/scraper-cache/places-reviews-preview.json" },
    });
    expect(exitCode).toBe(0);
  });

  test("write with '..' path traversal is blocked", async () => {
    const { exitCode } = await runHook("write", {
      tool_input: { file_path: ".pipeline/scraper-cache/../../secrets.env" },
    });
    expect(exitCode).toBe(2);
  });

  test("write to an unrelated path is blocked", async () => {
    const { exitCode } = await runHook("write", {
      tool_input: { file_path: "src/index.ts" },
    });
    expect(exitCode).toBe(2);
  });
});
