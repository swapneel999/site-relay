import { describe, test, expect } from "bun:test";
import { compileSchema, listClientIds, pipelineFileExists, loadPipelineFile } from "./helpers";

// Validates the backend agent's actual writes for every real client under
// clients/<client_id>/.pipeline/, not a hand-written example. Backend-agent
// never writes design-lock.json (read-only reference — see docs/spec.md's
// write-ownership rules and scripts/hooks/validate-backend-agent.ts), so
// there's nothing to validate there. This checks the two files
// backend-agent actually writes to instead: mockup-approval.json and
// qa-report.json. This is genuinely new coverage, not a duplicate of the
// design agent's dry-run test — design-lock.dry-run only ever validated
// design-lock.json and never exercised these two files' actual output
// against their schemas at all. Each (client, file) combination self-skips
// independently based on whether that client has actually produced that
// file yet at its current pipeline stage.
const clientIds = listClientIds();

describe("backend agent dry run — .pipeline/mockup-approval.json", () => {
  test.skipIf(clientIds.length > 0)(
    "no real clients found under clients/ (expected in a fresh checkout with no live client work yet)",
    () => {
      expect(clientIds.length).toBe(0);
    }
  );

  for (const clientId of clientIds) {
    const hasDryRunOutput = pipelineFileExists(clientId, "mockup-approval.json");

    test.skipIf(!hasDryRunOutput)(
      `[${clientId}] actual mockup-approval output validates against schemas/mockup-approval.schema.json`,
      () => {
        const validate = compileSchema("mockup-approval.schema.json");
        const output = loadPipelineFile(clientId, "mockup-approval.json");
        const ok = validate(output);
        if (!ok) {
          throw new Error(
            `clients/${clientId}/.pipeline/mockup-approval.json failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`
          );
        }
        expect(ok).toBe(true);
      }
    );

    test.skipIf(hasDryRunOutput)(
      `[${clientId}] no mockup-approval.json yet (expected before this client reaches mockup_review)`,
      () => {
        expect(hasDryRunOutput).toBe(false);
      }
    );
  }
});

describe("backend agent dry run — .pipeline/qa-report.json", () => {
  test.skipIf(clientIds.length > 0)(
    "no real clients found under clients/ (expected in a fresh checkout with no live client work yet)",
    () => {
      expect(clientIds.length).toBe(0);
    }
  );

  for (const clientId of clientIds) {
    const hasDryRunOutput = pipelineFileExists(clientId, "qa-report.json");

    test.skipIf(!hasDryRunOutput)(
      `[${clientId}] actual qa-report output validates against schemas/qa-report.schema.json`,
      () => {
        const validate = compileSchema("qa-report.schema.json");
        const output = loadPipelineFile(clientId, "qa-report.json");
        const ok = validate(output);
        if (!ok) {
          throw new Error(
            `clients/${clientId}/.pipeline/qa-report.json failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`
          );
        }
        expect(ok).toBe(true);
      }
    );

    test.skipIf(hasDryRunOutput)(
      `[${clientId}] no qa-report.json yet (expected before this client reaches qa)`,
      () => {
        expect(hasDryRunOutput).toBe(false);
      }
    );
  }
});
