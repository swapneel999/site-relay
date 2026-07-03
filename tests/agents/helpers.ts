import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSchema } from "../schemas/helpers";

const PIPELINE_DIR = join(import.meta.dir, "..", "..", ".pipeline");

export { compileSchema };

export function pipelineFilePath(fileName: string): string {
  return join(PIPELINE_DIR, fileName);
}

export function pipelineFileExists(fileName: string): boolean {
  return existsSync(pipelineFilePath(fileName));
}

export function loadPipelineFile(fileName: string): unknown {
  return JSON.parse(readFileSync(pipelineFilePath(fileName), "utf-8"));
}
