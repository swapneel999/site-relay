import { describe, test, expect } from "bun:test";
import { compileSchema, listClientIds, pipelineFileExists, loadPipelineFile } from "./helpers";

// Validates the qa agent's ACTUAL output for every real client under
// clients/<client_id>/.pipeline/, not a hand-written example. Each client
// self-skips independently until it has actually reached qa (see
// .claude/agents/qa-agent.md). qa-agent is the exclusive author of
// qa-report.json's findings/acceptance_criteria_check/round_result (with
// the narrow design/backend carve-out on status/agent_note for their own
// assigned findings), so this is the definitive check that its actual
// output conforms to the schema.
const clientIds = listClientIds();

describe("qa agent dry run — .pipeline/qa-report.json", () => {
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
