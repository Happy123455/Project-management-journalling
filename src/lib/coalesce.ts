/**
 * Wraps an async job so overlapping calls never get lost: a call that arrives while the job
 * is running makes it run once more afterwards (several such calls still mean one more run).
 */
export function coalesce(job: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await job();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return run;
}
