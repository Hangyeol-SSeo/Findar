import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL = 1000 * 60 * 60 * 18; // 18시간
const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "jobs.json");

function readStore(): Record<string, CacheEntry<unknown>> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, CacheEntry<unknown>>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(store));
  } catch {
    // 쓰기 실패 시 무시
  }
}

export function getCache<T>(key: string): T | null {
  const store = readStore();
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    delete store[key];
    writeStore(store);
    return null;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttl = DEFAULT_TTL): void {
  const store = readStore();
  store[key] = { data, expiresAt: Date.now() + ttl };
  writeStore(store);
}

export function clearCache(): void {
  writeStore({});
}
