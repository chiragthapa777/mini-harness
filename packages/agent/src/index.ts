/**
 * One agent run, assembled and persisted — the piece every gateway shares.
 *
 * This used to live in `apps/api/src/services`, which was fine while the API
 * was the only caller. The worker runs the same loop for scheduled work, so it
 * moved here rather than being copied: anything imported by more than one app
 * belongs in `packages/`.
 */
export { run, runStream, type PersistedRun, type RunRequest } from "./run.js";
export { toolsFor } from "./tools.js";
