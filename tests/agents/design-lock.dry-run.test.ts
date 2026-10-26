import { describe, test, expect } from "bun:test";
import { compileSchema, listClientIds, pipelineFileExists, loadPipelineFile } from "./helpers";

// Validates the design agent's ACTUAL output for every real client under
// clients/<client_id>/.pipeline/, not a hand-written example. Each client
// self-skips independently until it has actually reached design_locked (see
// the "Dry run & validation" section of .claude/agents/design-agent.md) —
// a client still in mockup_revision has no design-lock.json yet, and that's
// expected, not a failure.
const clientIds = listClientIds();

describe("design agent dry run — .pipeline/design-lock.json", () => {
  test.skipIf(clientIds.length > 0)(
    "no real clients found under clients/ (expected in a fresh checkout with no live client work yet)",
    () => {
      expect(clientIds.length).toBe(0);
    }
  );

  for (const clientId of clientIds) {
    const hasDryRunOutput = pipelineFileExists(clientId, "design-lock.json");

    test.skipIf(!hasDryRunOutput)(
      `[${clientId}] actual design-lock output validates against schemas/design-lock.schema.json`,
      () => {
        const validate = compileSchema("design-lock.schema.json");
        const output = loadPipelineFile(clientId, "design-lock.json");
        const ok = validate(output);
        if (!ok) {
          throw new Error(
            `clients/${clientId}/.pipeline/design-lock.json failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`
          );
        }
        expect(ok).toBe(true);
      }
    );

    test.skipIf(hasDryRunOutput)(
      `[${clientId}] no design-lock.json yet (expected before this client reaches design_locked)`,
      () => {
        expect(hasDryRunOutput).toBe(false);
      }
    );
  }
});
