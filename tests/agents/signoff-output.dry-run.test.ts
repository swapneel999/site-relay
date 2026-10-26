import { describe, test, expect } from "bun:test";
import { compileSchema, listClientIds, pipelineFileExists, loadPipelineFile } from "./helpers";

// Validates the integration lead agent's ACTUAL output for every real
// client under clients/<client_id>/.pipeline/, not a hand-written example.
// Each client self-skips independently until it has actually reached
// integration_signoff (see .claude/agents/integration-lead-agent.md).
// integration-lead-agent is the exclusive author of signoff.json's
// checklist/unresolved_majors/round_outcome/deployment fields
// (client_final_approval is client-approval intake's, a different writer
// entirely — see docs/spec.md section 6), so this is the definitive check
// that its actual output conforms to the schema.
const clientIds = listClientIds();

describe("integration lead agent dry run — .pipeline/signoff.json", () => {
  test.skipIf(clientIds.length > 0)(
    "no real clients found under clients/ (expected in a fresh checkout with no live client work yet)",
    () => {
      expect(clientIds.length).toBe(0);
    }
  );

  for (const clientId of clientIds) {
    const hasDryRunOutput = pipelineFileExists(clientId, "signoff.json");

    test.skipIf(!hasDryRunOutput)(
      `[${clientId}] actual signoff output validates against schemas/signoff.schema.json`,
      () => {
        const validate = compileSchema("signoff.schema.json");
        const output = loadPipelineFile(clientId, "signoff.json");
        const ok = validate(output);
        if (!ok) {
          throw new Error(
            `clients/${clientId}/.pipeline/signoff.json failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`
          );
        }
        expect(ok).toBe(true);
      }
    );

    test.skipIf(hasDryRunOutput)(
      `[${clientId}] no signoff.json yet (expected before this client reaches integration_signoff)`,
      () => {
        expect(hasDryRunOutput).toBe(false);
      }
    );
  }
});
