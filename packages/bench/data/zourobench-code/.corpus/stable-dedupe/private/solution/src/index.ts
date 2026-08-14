export interface RecordItem { id: string; value: number }
export function dedupeById(items: RecordItem[]): RecordItem[] { const seen = new Set<string>(); const out: RecordItem[] = []; for (const item of items) { if (!item.id.trim()) throw new Error("id required"); if (!seen.has(item.id)) { seen.add(item.id); out.push({ ...item }); } } return out; }
