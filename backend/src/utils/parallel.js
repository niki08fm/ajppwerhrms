/** Bound independent reads so a busy screen cannot flood the database pool. Order is preserved. */
export async function mapConcurrent(items, limit, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({
    length: Math.min(limit, items.length)
  }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await fn(items[index], index);
    }
  }));
  return result;
}
