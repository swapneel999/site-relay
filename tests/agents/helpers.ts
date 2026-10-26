import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSchema } from "../schemas/helpers";

// Real clients live at clients/<client_id>/.pipeline/, one git repo per
// client (see CLAUDE.md's "The seven pipeline files" table and
// docs/spec.md) — NOT at this schema-repo's own root .pipeline/, which
// never exists here and was never meant to. Each dry-run test discovers
// every real client and validates its actual pipeline output per file,
// self-skipping only the (client, file) combinations that don't apply yet
// at that client's current pipeline stage.
const CLIENTS_DIR = join(import.meta.dir, "..", "..", "clients");

export { compileSchema };

export function listClientIds(): string[] {
  if (!existsSync(CLIENTS_DIR)) return [];
  return readdirSync(CLIENTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(CLIENTS_DIR, entry.name, ".pipeline")))
    .map((entry) => entry.name)
    .sort();
}

export function pipelineFilePath(clientId: string, fileName: string): string {
  return join(CLIENTS_DIR, clientId, ".pipeline", fileName);
}

export function pipelineFileExists(clientId: string, fileName: string): boolean {
  return existsSync(pipelineFilePath(clientId, fileName));
}

export function loadPipelineFile(clientId: string, fileName: string): unknown {
  return JSON.parse(readFileSync(pipelineFilePath(clientId, fileName), "utf-8"));
}
