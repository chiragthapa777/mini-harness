import type { Tool } from "@mini-agent/coder-core";
import { bashTool, createBashTool } from "./bash.js";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { globTool, grepTool } from "./search.js";

export { bashTool, editFileTool, globTool, grepTool, readFileTool, writeFileTool };
export { display, resolveInProject } from "./paths.js";

/** The tools the model gets. With `sandbox`, bash runs confined by the operating system. */
export function createTools(options: { sandbox?: boolean } = {}): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, globTool, grepTool, createBashTool(options)];
}
