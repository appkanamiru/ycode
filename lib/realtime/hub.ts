/**
 * Realtime Hub
 *
 * Replaces Supabase Realtime (broadcast + presence) on plain Postgres. Each
 * app instance holds its SSE connections and their channel memberships;
 * messages and presence go through a backend (memory, or Redis across
 * instances). Channels are always scoped to the connection's tenant.
 *
 * Stored on globalThis: the stream and publish routes are separate bundles
 * that must share one hub per process.
 */

import { randomUUID } from 'crypto';

import {
  createMemoryBackend,
  createRedisBackend,
  type BackendMessage,
  type RealtimeBackend,
} from './backends';
import { MAX_CHANNEL_LENGTH, type PresenceState, type RealtimeAction, type RealtimeEvent } from './protocol';

const PRESENCE_REFRESH_MS = 15_000;
const MAX_EVENT_LENGTH = 100;
const VALID_NAME = /^[\w:.\-/]+$/;

interface Connection {
  id: string;
  tenantId: string | null;
  userId: string;
  push: (event: RealtimeEvent) => void;
  channels: Set<string>;
  tracked: Set<string>;
}

export class RealtimeError extends Error {}

function validateName(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || !VALID_NAME.test(value)) {
    throw new RealtimeError(`Invalid ${label}`);
  }
  return value;
}

export class RealtimeHub {
  private connections = new Map<string, Connection>();
  /** scope -> connection ids on this instance */
  private members = new Map<string, Set<string>>();
  private refreshTimer: ReturnType<typeof setInterval>;

  constructor(private readonly backend: RealtimeBackend) {
    backend.subscribe((message) => this.receive(message));
    this.refreshTimer = setInterval(() => this.refreshPresence(), PRESENCE_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  private scope(tenantId: string | null, channel: string): string {
    return `${tenantId ?? '-'}:${channel}`;
  }

  connect(tenantId: string | null, userId: string, push: (event: RealtimeEvent) => void): string {
    const id = randomUUID();
    this.connections.set(id, { id, tenantId, userId, push, channels: new Set(), tracked: new Set() });
    return id;
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    for (const channel of [...connection.channels]) {
      await this.leave(connection, channel);
    }
    this.connections.delete(connectionId);
  }

  /**
   * Run an action for a connection. The caller has verified that the
   * connection belongs to the requester (signed token); when another instance
   * holds it, the action is forwarded there.
   */
  async handle(connectionId: string, action: RealtimeAction): Promise<void> {
    const channel = validateName(action.channel, MAX_CHANNEL_LENGTH, 'channel');
    const connection = this.connections.get(connectionId);
    if (!connection) {
      await this.backend.publish({ kind: 'action', connectionId, action });
      return;
    }

    switch (action.action) {
      case 'join':
        return this.join(connection, channel);
      case 'leave':
        return this.leave(connection, channel);
      case 'send': {
        const event = validateName(action.event, MAX_EVENT_LENGTH, 'event');
        if (!connection.channels.has(channel)) throw new RealtimeError('Not joined');
        await this.backend.publish({
          kind: 'broadcast', scope: this.scope(connection.tenantId, channel), channel, event, payload: action.payload, from: connection.id,
        });
        return;
      }
      case 'track':
        return this.track(connection, channel, action.state);
      case 'untrack':
        return this.untrack(connection, channel);
      default:
        throw new RealtimeError('Unknown action');
    }
  }

  /** Broadcast from server code (e.g. MCP tools) to a tenant's channel */
  async publishFromServer(tenantId: string | null, channel: string, event: string, payload: unknown): Promise<void> {
    await this.backend.publish({ kind: 'broadcast', scope: this.scope(tenantId, channel), channel, event, payload });
  }

  private async join(connection: Connection, channel: string): Promise<void> {
    const scope = this.scope(connection.tenantId, channel);
    connection.channels.add(channel);
    if (!this.members.has(scope)) this.members.set(scope, new Set());
    this.members.get(scope)!.add(connection.id);

    connection.push({ type: 'presence_state', channel, presences: await this.backend.getPresence(scope) });
  }

  private async leave(connection: Connection, channel: string): Promise<void> {
    await this.untrack(connection, channel);
    connection.channels.delete(channel);

    const scope = this.scope(connection.tenantId, channel);
    const members = this.members.get(scope);
    members?.delete(connection.id);
    if (members?.size === 0) this.members.delete(scope);
  }

  private async track(connection: Connection, channel: string, state: PresenceState): Promise<void> {
    if (!connection.channels.has(channel)) throw new RealtimeError('Not joined');
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new RealtimeError('Invalid presence');

    const scope = this.scope(connection.tenantId, channel);
    connection.tracked.add(channel);
    await this.backend.setPresence(scope, connection.id, state);
    await this.backend.publish({ kind: 'presence', scope, channel, change: 'join', key: connection.id, state });
  }

  private async untrack(connection: Connection, channel: string): Promise<void> {
    if (!connection.tracked.delete(channel)) return;

    const scope = this.scope(connection.tenantId, channel);
    const removed = await this.backend.removePresence(scope, connection.id);
    if (removed) {
      await this.backend.publish({ kind: 'presence', scope, channel, change: 'leave', key: connection.id, state: removed });
    }
  }

  private receive(message: BackendMessage): void {
    if (message.kind === 'action') {
      const connection = this.connections.get(message.connectionId);
      if (connection) {
        this.handle(connection.id, message.action).catch((error) => {
          console.error('[realtime] Forwarded action failed:', error);
        });
      }
      return;
    }

    for (const connectionId of this.members.get(message.scope) ?? []) {
      const connection = this.connections.get(connectionId);
      if (!connection) continue;

      if (message.kind === 'broadcast') {
        // Like Supabase's default `self: false`: senders don't get their own messages
        if (message.from === connectionId) continue;
        connection.push({ type: 'broadcast', channel: message.channel, event: message.event, payload: message.payload });
      } else {
        connection.push({
          type: message.change === 'join' ? 'presence_join' : 'presence_leave',
          channel: message.channel,
          key: message.key,
          state: message.state,
        });
      }
    }
  }

  private refreshPresence(): void {
    const entries = [...this.connections.values()].flatMap((connection) =>
      [...connection.tracked].map((channel) => ({ scope: this.scope(connection.tenantId, channel), key: connection.id })),
    );
    this.backend.refreshPresence(entries).catch((error) => console.error('[realtime] Presence refresh failed:', error));
  }

  async stop(): Promise<void> {
    clearInterval(this.refreshTimer);
    await this.backend.close();
  }
}

const globalForRealtime = globalThis as unknown as { __realtimeHub?: RealtimeHub };

export function getRealtimeHub(): RealtimeHub {
  globalForRealtime.__realtimeHub ??= new RealtimeHub(
    process.env.REDIS_URL ? createRedisBackend(process.env.REDIS_URL) : createMemoryBackend(),
  );
  return globalForRealtime.__realtimeHub;
}
