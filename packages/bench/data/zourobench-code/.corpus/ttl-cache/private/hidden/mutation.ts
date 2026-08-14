export class TtlCache<K, V> {
  constructor(_capacity: number, _ttlMs: number, _now: () => number = Date.now) {}
  get(_key: K): V | undefined { return undefined; }
  set(_key: K, _value: V): void {}
  delete(_key: K): boolean { return false; }
  get size(): number { return 0; }
}
