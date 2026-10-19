const operationTails = new Map<string, Promise<void>>();

/** Serialize token-store mutations for one account without blocking other users. */
export async function withWeTrakrTokenLock<T>(
  reference: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = operationTails.get(reference) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  operationTails.set(reference, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (operationTails.get(reference) === queued)
      operationTails.delete(reference);
  }
}
