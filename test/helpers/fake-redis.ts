/**
 * Minimal in-memory Redis fake — just enough of the ioredis surface used by
 * RedlockService and RedisMemoryStore, so unit tests run with no live Redis.
 *
 * Supports: SET ... PX NX, the compare-and-del release Lua (via eval),
 * LRANGE, RPUSH, and MULTI(DEL/RPUSH/EXEC). TTL expiry is not simulated (tests
 * don't depend on it).
 */
export class FakeRedis {
  private strings = new Map<string, string>();
  private lists = new Map<string, string[]>();

  async set(
    key: string,
    value: string,
    _px?: string,
    _ttl?: number,
    nx?: string,
  ): Promise<'OK' | null> {
    if (nx === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  // Atomic increment of an integer string (creates at 0 if absent), as the SQS
  // consumer's per-message attempt counter uses.
  async incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }

  // TTL is not simulated (tests don't depend on expiry); accept and no-op.
  async pexpire(_key: string, _ttlMs: number): Promise<number> {
    return this.strings.has(_key) ? 1 : 0;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed++;
      if (this.lists.delete(key)) removed++;
    }
    return removed;
  }

  // Emulates the RedlockService compare-and-delete release script.
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    token: string,
  ): Promise<number> {
    if (this.strings.get(key) === token) {
      this.strings.delete(key);
      return 1;
    }
    return 0;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  multi(): FakeMulti {
    return new FakeMulti(this.lists);
  }

  // test introspection
  _listLength(key: string): number {
    return (this.lists.get(key) ?? []).length;
  }
}

class FakeMulti {
  private ops: Array<() => void> = [];
  constructor(private lists: Map<string, string[]>) {}

  del(key: string): this {
    this.ops.push(() => this.lists.delete(key));
    return this;
  }

  rpush(key: string, ...values: string[]): this {
    this.ops.push(() => {
      const list = this.lists.get(key) ?? [];
      list.push(...values);
      this.lists.set(key, list);
    });
    return this;
  }

  async exec(): Promise<void> {
    for (const op of this.ops) op();
  }
}
