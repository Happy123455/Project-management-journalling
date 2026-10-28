/**
 * Runs writes one after another. Two overlapping saves of a new day would otherwise both
 * see "no page yet" and both try to create it, and the second fails ("Save failed").
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => {});
    return result;
  }
}
