import { randomBytes, createHash } from "node:crypto";
// Capability is kept in memory, expires after 20 minutes and is scoped to one job.
const state = globalThis as typeof globalThis & { findarFillSessions?: Map<string, { seq: string; expires: number }> };
const sessions = state.findarFillSessions ??= new Map();
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export function createFillSession(seq: string) {
  for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
  const token = randomBytes(32).toString("hex");
  sessions.set(hash(token), { seq, expires: Date.now() + 20 * 60 * 1000 });
  return token;
}
export function verifyFillSession(token: string, seq: string) {
  const session = sessions.get(hash(token));
  return Boolean(session && session.seq === seq && session.expires > Date.now());
}
export function localRequest(request: Request) {
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}
