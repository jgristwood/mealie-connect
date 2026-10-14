/** Like Promise.allSettled over items.map(task), but runs at most `limit`
 * tasks at once so large libraries don't flood the Mealie server. */
export async function settleWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index] as T) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
