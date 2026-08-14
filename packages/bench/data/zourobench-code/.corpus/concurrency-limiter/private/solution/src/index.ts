export async function mapConcurrent<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be positive");
  const results = new Array<R>(items.length); let cursor = 0; let failure: unknown;
  async function worker(): Promise<void> { while (failure === undefined) { const index = cursor++; if (index >= items.length) return; try { results[index] = await mapper(items[index]!, index); } catch (error) { failure = error; return; } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure; return results;
}
