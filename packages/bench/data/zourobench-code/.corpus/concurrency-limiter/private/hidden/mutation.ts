export async function mapConcurrent<T, R>(_items: T[], _limit: number, _mapper: (item: T, index: number) => Promise<R>): Promise<R[]> { return []; }
