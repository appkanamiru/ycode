/**
 * Realtime Browser Client
 *
 * The subset of the Supabase Realtime client API the collaboration hooks use
 * (channel, on, subscribe, send, track, untrack, presenceState, unsubscribe,
 * removeChannel), over one SSE stream per tab plus POST actions. Used on
 * plain Postgres, where Supabase Realtime is not available.
 */

import {
  REALTIME_PUBLISH_PATH,
  REALTIME_STREAM_PATH,
  REALTIME_TOKEN_HEADER,
  type PresenceState,
  type RealtimeAction,
  type RealtimeEvent,
  type RealtimeReady,
} from './protocol';

type Status = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'CLOSED';
type Presences = Record<string, Array<PresenceState & { presence_ref: string }>>;

interface Listener {
  type: 'broadcast' | 'presence';
  event: string;
  callback: (payload: any) => void;
}

function toPresences(states: Map<string, PresenceState>): Presences {
  return Object.fromEntries([...states].map(([key, state]) => [key, [{ ...state, presence_ref: key }]]));
}

export class PlatformRealtimeChannel {
  private listeners: Listener[] = [];
  private statusCallback?: (status: Status, error?: Error) => void;
  /** Re-sent after reconnecting */
  trackedState: PresenceState | null = null;

  constructor(private readonly client: PlatformRealtimeClient, readonly topic: string) {}

  on(type: 'broadcast' | 'presence', filter: { event: string }, callback: (payload: any) => void): this {
    this.listeners.push({ type, event: filter.event, callback });
    return this;
  }

  subscribe(callback?: (status: Status, error?: Error) => void): this {
    this.statusCallback = callback;
    this.client.attach(this);
    return this;
  }

  async send(message: { type: string; event: string; payload?: unknown }): Promise<'ok' | 'error'> {
    if (message.type !== 'broadcast') return 'error';
    const sent = await this.client.action({ action: 'send', channel: this.topic, event: message.event, payload: message.payload });
    return sent ? 'ok' : 'error';
  }

  async track(state: PresenceState): Promise<'ok' | 'error'> {
    this.trackedState = state;
    return (await this.client.action({ action: 'track', channel: this.topic, state })) ? 'ok' : 'error';
  }

  async untrack(): Promise<'ok' | 'error'> {
    this.trackedState = null;
    return (await this.client.action({ action: 'untrack', channel: this.topic })) ? 'ok' : 'error';
  }

  presenceState(): Presences {
    return toPresences(this.client.presenceOf(this.topic));
  }

  async unsubscribe(): Promise<'ok'> {
    await this.client.detach(this);
    this.setStatus('CLOSED');
    return 'ok';
  }

  /** @internal */
  setStatus(status: Status): void {
    this.statusCallback?.(status);
  }

  /** @internal */
  emit(type: 'broadcast' | 'presence', event: string, payload: unknown): void {
    for (const listener of this.listeners) {
      if (listener.type === type && (listener.event === event || listener.event === '*')) {
        try {
          listener.callback(payload);
        } catch (error) {
          console.error('[realtime] Listener failed:', error);
        }
      }
    }
  }
}

export class PlatformRealtimeClient {
  private source: EventSource | null = null;
  private ready: RealtimeReady | null = null;
  private channels = new Map<string, Set<PlatformRealtimeChannel>>();
  private presence = new Map<string, Map<string, PresenceState>>();
  /** Topics joined on the current connection */
  private joined = new Set<string>();

  channel(topic: string): PlatformRealtimeChannel {
    return new PlatformRealtimeChannel(this, topic);
  }

  async removeChannel(channel: PlatformRealtimeChannel): Promise<'ok'> {
    return channel.unsubscribe();
  }

  async removeAllChannels(): Promise<'ok'[]> {
    const all = [...this.channels.values()].flatMap((set) => [...set]);
    return Promise.all(all.map((channel) => channel.unsubscribe()));
  }

  presenceOf(topic: string): Map<string, PresenceState> {
    return this.presence.get(topic) ?? new Map();
  }

  /** @internal */
  attach(channel: PlatformRealtimeChannel): void {
    const existing = this.channels.get(channel.topic);
    if (existing) {
      existing.add(channel);
      if (this.joined.has(channel.topic)) {
        channel.setStatus('SUBSCRIBED');
        channel.emit('presence', 'sync', undefined);
      }
      return;
    }

    this.channels.set(channel.topic, new Set([channel]));
    if (this.ready) {
      this.joinTopic(channel.topic);
    } else {
      this.connect();
    }
  }

  /** @internal */
  async detach(channel: PlatformRealtimeChannel): Promise<void> {
    const set = this.channels.get(channel.topic);
    if (!set?.delete(channel)) return;

    if (set.size > 0) {
      if (channel.trackedState) await this.action({ action: 'untrack', channel: channel.topic });
      return;
    }

    this.channels.delete(channel.topic);
    this.presence.delete(channel.topic);
    if (this.joined.delete(channel.topic)) {
      await this.action({ action: 'leave', channel: channel.topic });
    }
    if (this.channels.size === 0) this.disconnect();
  }

  /** @internal Returns false when the action could not be delivered */
  async action(action: RealtimeAction): Promise<boolean> {
    if (!this.ready) return false;
    try {
      const response = await fetch(REALTIME_PUBLISH_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [REALTIME_TOKEN_HEADER]: this.ready.token },
        body: JSON.stringify(action),
      });
      // Expired token: a new connection re-checks the session and issues a new one
      if (response.status === 401) this.reconnect();
      return response.ok;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.source) return;
    const source = new EventSource(REALTIME_STREAM_PATH);
    this.source = source;

    source.addEventListener('ready', (event) => {
      this.ready = JSON.parse((event as MessageEvent).data);
      this.joined.clear();
      for (const topic of this.channels.keys()) this.joinTopic(topic);
    });

    source.addEventListener('message', (event) => {
      this.receive(JSON.parse((event as MessageEvent).data) as RealtimeEvent);
    });

    // The browser retries on its own; channels report the outage meanwhile
    source.addEventListener('error', () => {
      this.ready = null;
      this.joined.clear();
      this.channels.forEach((set) => set.forEach((channel) => channel.setStatus('CHANNEL_ERROR')));
    });
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
    this.ready = null;
    this.joined.clear();
  }

  private reconnect(): void {
    this.disconnect();
    if (this.channels.size > 0) this.connect();
  }

  private async joinTopic(topic: string): Promise<void> {
    if (!(await this.action({ action: 'join', channel: topic }))) return;
    this.joined.add(topic);

    for (const channel of this.channels.get(topic) ?? []) {
      channel.setStatus('SUBSCRIBED');
      if (channel.trackedState) await channel.track(channel.trackedState);
    }
  }

  private receive(event: RealtimeEvent): void {
    const channels = this.channels.get(event.channel);
    if (!channels) return;
    const emit = (type: 'broadcast' | 'presence', name: string, payload: unknown) =>
      channels.forEach((channel) => channel.emit(type, name, payload));

    if (event.type === 'broadcast') {
      emit('broadcast', event.event, { type: 'broadcast', event: event.event, payload: event.payload });
      return;
    }

    if (event.type === 'presence_state') {
      this.presence.set(event.channel, new Map(Object.entries(event.presences)));
      emit('presence', 'sync', undefined);
      return;
    }

    const states = this.presence.get(event.channel) ?? new Map<string, PresenceState>();
    this.presence.set(event.channel, states);
    const presence = { ...event.state, presence_ref: event.key };

    if (event.type === 'presence_join') {
      states.set(event.key, event.state);
      emit('presence', 'join', { key: event.key, newPresences: [presence], currentPresences: [] });
    } else {
      states.delete(event.key);
      emit('presence', 'leave', { key: event.key, leftPresences: [presence], currentPresences: [] });
    }
    emit('presence', 'sync', undefined);
  }
}

let client: PlatformRealtimeClient | null = null;

export function getPlatformRealtimeClient(): PlatformRealtimeClient {
  client ??= new PlatformRealtimeClient();
  return client;
}
