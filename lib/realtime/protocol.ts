/**
 * Realtime Protocol
 *
 * Shared by the server hub and the browser client. The server streams
 * events over SSE; the client sends actions with HTTP POST.
 */

export type PresenceState = Record<string, unknown>;

/** Server -> client, one SSE `message` event each */
export type RealtimeEvent =
  | { type: 'broadcast'; channel: string; event: string; payload: unknown }
  /** Full presence of a channel, keyed by connection id */
  | { type: 'presence_state'; channel: string; presences: Record<string, PresenceState> }
  | { type: 'presence_join'; channel: string; key: string; state: PresenceState }
  | { type: 'presence_leave'; channel: string; key: string; state: PresenceState };

/** Client -> server */
export type RealtimeAction =
  | { action: 'join'; channel: string }
  | { action: 'leave'; channel: string }
  | { action: 'send'; channel: string; event: string; payload: unknown }
  | { action: 'track'; channel: string; state: PresenceState }
  | { action: 'untrack'; channel: string };

/** Sent once per SSE connection, before any other event */
export interface RealtimeReady {
  connectionId: string;
  /** Authorizes the POST actions of this connection */
  token: string;
}

export const REALTIME_STREAM_PATH = '/ycode/api/realtime/stream';
export const REALTIME_PUBLISH_PATH = '/ycode/api/realtime/publish';
export const REALTIME_TOKEN_HEADER = 'x-realtime-token';

export const MAX_CHANNEL_LENGTH = 200;
export const MAX_ACTION_BYTES = 64 * 1024;
