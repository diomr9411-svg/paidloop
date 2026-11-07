// One at a time. Code that awaits (PayPal, files) can interleave with other requests,
// so work that must not overlap, such as handing out invoice numbers, waits its turn here.
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(work, work);
    // The next caller waits for this one to finish, whether it worked or failed
    this.tail = result.catch(() => undefined);
    return result;
  }
}
