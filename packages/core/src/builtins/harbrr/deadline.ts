export async function collectHarbrrResultsUntilDeadline<T>(
  tasks: Array<Promise<T[]>>,
  deadlineMs: number,
  onError?: (error: unknown) => void
): Promise<T[]> {
  // Keep results in query order even though requests are allowed to complete
  // concurrently. More importantly, never let a promise that settles after
  // the deadline mutate the array that has already been returned to the
  // caller; that race made repeated scrapes appear inconsistent.
  const resultsByTask: Array<T[] | undefined> = new Array(tasks.length);
  let deadlineReached = false;
  let timeout: NodeJS.Timeout | undefined;
  const settled = Promise.allSettled(
    tasks.map(async (task, index) => {
      try {
        resultsByTask[index] = await task;
      } catch (error) {
        if (!deadlineReached) onError?.(error);
      }
    })
  );
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(
      () => {
        deadlineReached = true;
        resolve();
      },
      Math.max(1, deadlineMs)
    );
  });
  try {
    await Promise.race([settled, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return resultsByTask.flatMap((results) => results ?? []);
}
