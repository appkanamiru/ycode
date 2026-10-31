/**
 * Realtime Backends
 *
 * Fan-out of messages between app instances and shared presence state.
 * - memory: a single instance (default, and for development)
 * - redis: several instances, enabled with REDIS_URL
 */

import Redis from 'ioredis';

import type { PresenceState, RealtimeAction } from './protocol';

/** Messages between hub instances; `scope` is the tenant-prefixed channel */
export type BackendMessage =
  | { kind: 'broadcast'; scope: string; channel: string; event: string; payload: unknown; from?: string }
  | { kind: 'presence'; scope: string; channel: string; change: 'join' | 'leave'; key: string; state: PresenceState }
  /** An action for a connection held by another instance */
  | { kind: 'action'; connectionId: string; action: RealtimeAction };

export interface RealtimeBackend {
  publish(message: BackendMessage): Promise<void>;
  subscribe(handler: (message: BackendMessage) => void): void;
  setPresence(scope: string, key: string, state: PresenceState): Promise<void>;
  /** Returns the removed state, if there was one */
  removePresence(scope: string, key: string): Promise<PresenceState | null>;
  getPresence(scope: string): Promise<Record<string, PresenceState>>;
  /** Keep presences of live connections from expiring */
  refreshPresence(entries: Array<{ scope: string; key: string }>): Promise<void>;
  close(): Promise<void>;
}

export function createMemoryBackend(): RealtimeBackend {
  const handlers: Array<(message: BackendMessage) => void> = [];
  const presence = new Map<string, Map<string, PresenceState>>();

  return {
    async publish(message) {
      handlers.forEach((handler) => handler(message));
    },
    subscribe(handler) {
      handlers.push(handler);
    },
    async setPresence(scope, key, state) {
      if (!presence.has(scope)) presence.set(scope, new Map());
      presence.get(scope)!.set(key, state);
    },
    async removePresence(scope, key) {
      const states = presence.get(scope);
      const removed = states?.get(key) ?? null;
      states?.delete(key);
      if (states?.size === 0) presence.delete(scope);
      return removed;
    },
    async getPresence(scope) {
      return Object.fromEntries(presence.get(scope) ?? []);
    },
    async refreshPresence() {},
    async close() {},
  };
}

const REDIS_CHANNEL = 'ycode:realtime';
/** A presence not refreshed for this long belongs to a dead instance */
const PRESENCE_STALE_MS = 45_000;
const PRESENCE_KEY_TTL_S = 120;

export function createRedisBackend(url: string): RealtimeBackend {
  const commands = new Redis(url, { lazyConnect: false });
  const subscriber = new Redis(url, { lazyConnect: false });
  const handlers: Array<(message: BackendMessage) => void> = [];
  const presenceKey = (scope: string) => `ycode:presence:${scope}`;

  subscriber.subscribe(REDIS_CHANNEL).catch((error) => console.error('[realtime] Redis subscribe failed:', error));
  subscriber.on('message', (_channel, raw) => {
    try {
      const message = JSON.parse(raw) as BackendMessage;
      handlers.forEach((handler) => handler(message));
    } catch (error) {
      console.error('[realtime] Invalid message from Redis:', error);
    }
  });

  return {
    async publish(message) {
      await commands.publish(REDIS_CHANNEL, JSON.stringify(message));
    },
    subscribe(handler) {
      handlers.push(handler);
    },
    async setPresence(scope, key, state) {
      await commands.multi()
        .hset(presenceKey(scope), key, JSON.stringify({ state, seen: Date.now() }))
        .expire(presenceKey(scope), PRESENCE_KEY_TTL_S)
        .exec();
    },
    async removePresence(scope, key) {
      const [[, raw]] = (await commands.multi().hget(presenceKey(scope), key).hdel(presenceKey(scope), key).exec())!;
      return raw ? JSON.parse(raw as string).state : null;
    },
    async getPresence(scope) {
      const entries = await commands.hgetall(presenceKey(scope));
      const live: Record<string, PresenceState> = {};
      const stale: string[] = [];
      for (const [key, raw] of Object.entries(entries)) {
        const { state, seen } = JSON.parse(raw);
        if (Date.now() - seen > PRESENCE_STALE_MS) stale.push(key);
        else live[key] = state;
      }
      if (stale.length) await commands.hdel(presenceKey(scope), ...stale);
      return live;
    },
    async refreshPresence(entries) {
      if (entries.length === 0) return;
      const pipeline = commands.pipeline();
      for (const { scope, key } of entries) {
        pipeline.hget(presenceKey(scope), key);
      }
      const current = (await pipeline.exec()) ?? [];

      const refresh = commands.pipeline();
      entries.forEach(({ scope, key }, i) => {
        const raw = current[i]?.[1] as string | null;
        if (!raw) return;
        const { state } = JSON.parse(raw);
        refresh.hset(presenceKey(scope), key, JSON.stringify({ state, seen: Date.now() }));
        refresh.expire(presenceKey(scope), PRESENCE_KEY_TTL_S);
      });
      await refresh.exec();
    },
    async close() {
      await Promise.all([commands.quit(), subscriber.quit()]);
    },
  };
}
