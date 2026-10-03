import type { Tool } from "@mini-agent/coder-core";
import { bashTool } from "./bash.js";
import { editFileTool, readFileTool } from "./files.js";

export { bashTool, editFileTool, readFileTool };
export { display, resolveInProject } from "./paths.js";

/** The tools `serve` gives the model. Phase 5 adds write_file, glob and grep. */
export const defaultTools: Tool[] = [readFileTool, editFileTool, bashTool];
