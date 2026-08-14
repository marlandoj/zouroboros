export interface RecordItem { id: string; value: number }
export function dedupeById(items: RecordItem[]): RecordItem[] { return [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id)); }
