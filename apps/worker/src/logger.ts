/** Same shape and format as the API's logger, tagged so mixed output is readable. */
export const logger = {
  info(message: string): void {
    console.log(`[INFO][worker][${new Date().toISOString()}] ${message}`);
  },
  error(message: string, err?: unknown): void {
    console.log(`[ERROR][worker][${new Date().toISOString()}] ${message}`, err ?? "");
  },
};
