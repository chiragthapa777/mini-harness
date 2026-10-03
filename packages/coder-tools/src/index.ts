import type { Tool } from "@mini-agent/coder-core";
import { bashTool } from "./bash.js";
import { editFileTool, readFileTool } from "./files.js";

export { bashTool } from "./bash.js";
export { editFileTool, readFileTool } from "./files.js";
export { PathError, display, resolveInProject } from "./paths.js";

/** The tool set `serve` registers. Phase 5 adds write_file, glob and grep. */
export const defaultTools: Tool[] = [readFileTool, editFileTool, bashTool];
