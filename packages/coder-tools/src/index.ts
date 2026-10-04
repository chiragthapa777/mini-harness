import type { Tool } from "@mini-agent/coder-core";
import { bashTool } from "./bash.js";
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { globTool, grepTool } from "./search.js";

export { bashTool, editFileTool, globTool, grepTool, readFileTool, writeFileTool };
export { display, resolveInProject } from "./paths.js";

/** The tools the model gets. */
export const defaultTools: Tool[] = [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool];
