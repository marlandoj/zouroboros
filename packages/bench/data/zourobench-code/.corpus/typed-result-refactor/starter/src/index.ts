export interface ParseResult { ok: boolean; value?: number; error?: string }
export function parsePort(raw: string): ParseResult { const value = Number(raw); if (!value) throw new Error("invalid"); return { ok: true, value }; }
