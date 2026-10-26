#!/usr/bin/env bun
// CLI wrapper around Gemini image generation ("Nano Banana"), so the design
// agent can generate imagery via Bash without ever seeing the raw API key —
// it stays in this process's env, read once here, never echoed or logged.
//
// Usage:
//   bun scripts/generate-image.ts --model flash --prompt "..." --out path/to/file.png
//   bun scripts/generate-image.ts --model pro --prompt "..." --out path/to/file.png
//
// Requires GEMINI_API_KEY in the environment — a Google AI Studio key with
// its own Google Cloud billing enabled. A consumer Gemini Pro subscription
// does NOT cover this; see .claude/agents/design-agent.md.
//
// MODEL ID / API SHAPE NOTE: rewritten 2026-07-20 to match the documented
// standard generateContent shape (endpoint, request body, and response
// parsing) at https://ai.google.dev/gemini-api/docs/image-generation.
// VERIFIED LIVE on 2026-07-20 — a real call with --model flash returned a
// valid, non-empty image (Gemini's "flash" model returned image/jpeg, not
// image/png, hence the mimeType check below accepts any "image/*" rather
// than hardcoding png). Re-verify if Google changes model IDs or shape again
// (this family has been renamed multiple times: Nano Banana -> Nano Banana 2
// -> Nano Banana 2 Lite, plus Pro).

export {};

const MODEL_IDS = {
  flash: "gemini-3.1-flash-image",
  pro: "gemini-3-pro-image",
} as const;

const API_KEY = process.env.GEMINI_API_KEY;

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

if (!API_KEY) {
  fail("GEMINI_API_KEY is not set in the environment.");
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const modelKey = args.model as keyof typeof MODEL_IDS;

if (modelKey !== "flash" && modelKey !== "pro") {
  fail(`--model must be "flash" or "pro", got "${args.model ?? ""}"`);
}
if (!args.prompt) fail("--prompt is required");
if (!args.out) fail("--out (output file path) is required");

const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_IDS[modelKey]}:generateContent`,
  {
    method: "POST",
    headers: {
      "x-goog-api-key": API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: args.prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  }
);

if (!res.ok) {
  fail(`Gemini image generation failed: HTTP ${res.status} ${await res.text()}`);
}

const json: any = await res.json();

const imagePart = json?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData);
const base64: string | null = imagePart?.inlineData?.data ?? null;
const mimeType: string | undefined = imagePart?.inlineData?.mimeType;

if (!base64) {
  fail(`Gemini response did not contain image data in the expected shape: ${JSON.stringify(json)}`);
}
if (mimeType && !mimeType.startsWith("image/")) {
  fail(`Gemini returned non-image mimeType "${mimeType}": ${JSON.stringify(json)}`);
}

await Bun.write(args.out, Buffer.from(base64, "base64"));

console.log(JSON.stringify({ file_path: args.out, model: MODEL_IDS[modelKey] }));
