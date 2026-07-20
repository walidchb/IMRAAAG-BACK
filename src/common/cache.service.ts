import { Injectable } from '@nestjs/common';

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

@Injectable()
export class CacheService {
  private store = new Map<string, CacheEntry<any>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiry: Date.now() + ttlMs });
  }

  clear(pattern?: string): void {
    if (!pattern) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(pattern)) {
        this.store.delete(key);
      }
    }
  }
}
