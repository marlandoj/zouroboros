export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  constructor(private readonly capacity: number, private readonly ttlMs: number, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1 || ttlMs < 0) throw new Error("invalid cache bounds");
  }
  private purge(): void { for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key); }
  get(key: K): V | undefined {
    this.purge(); const entry = this.entries.get(key); if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry); return entry.value;
  }
  set(key: K, value: V): void {
    this.purge(); this.entries.delete(key);
    while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value as K);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
  delete(key: K): boolean { return this.entries.delete(key); }
  get size(): number { this.purge(); return this.entries.size; }
}
