/** Console today, tagged with a timestamp. Swap the sink here if that ever needs to change. */
export const logger = {
  info(message: string): void {
    console.log(`[INFO][${new Date().toISOString()}] ${message}`);
  },
  error(message: string, err?: unknown): void {
    console.log(`[ERROR][${new Date().toISOString()}] ${message}`, err);
  },
};
