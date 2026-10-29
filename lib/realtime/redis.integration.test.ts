/**
 * Two hub instances sharing Redis, like two app instances behind a load
 * balancer. Skipped unless REDIS_TEST_URL is set, e.g.:
 *
 *   docker run -d -p 56379:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://localhost:56379 npm test
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import Redis from 'ioredis';

import { createRedisBackend } from './backends';
import { RealtimeHub } from './hub';
import type { RealtimeEvent } from './protocol';

const REDIS_URL = process.env.REDIS_TEST_URL;
const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let first: RealtimeHub;
let second: RealtimeHub;

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connect(hub: RealtimeHub) {
  const events: RealtimeEvent[] = [];
  const id = hub.connect(TENANT, 'user', (event) => events.push(event));
  return { id, events };
}

before(async () => {
  if (!REDIS_URL) return;
  const redis = new Redis(REDIS_URL);
  await redis.flushdb();
  await redis.quit();
  first = new RealtimeHub(createRedisBackend(REDIS_URL));
  second = new RealtimeHub(createRedisBackend(REDIS_URL));
  // Let both subscribers connect
  await new Promise((resolve) => setTimeout(resolve, 200));
});

after(async () => {
  await first?.stop();
  await second?.stop();
});

test('broadcasts and presence cross instances', { skip: !REDIS_URL }, async () => {
  const alice = connect(first);
  const bob = connect(second);
  await first.handle(alice.id, { action: 'join', channel: 'room' });
  await first.handle(alice.id, { action: 'track', channel: 'room', state: { name: 'Alice' } });
  await second.handle(bob.id, { action: 'join', channel: 'room' });

  const state = bob.events.find((event) => event.type === 'presence_state');
  assert.deepEqual(state, { type: 'presence_state', channel: 'room', presences: { [alice.id]: { name: 'Alice' } } });

  await second.handle(bob.id, { action: 'send', channel: 'room', event: 'ping', payload: 1 });
  await waitFor(() => alice.events.some((event) => event.type === 'broadcast'));
  assert.equal(bob.events.filter((event) => event.type === 'broadcast').length, 0, 'sender excluded');

  await first.disconnect(alice.id);
  await waitFor(() => bob.events.some((event) => event.type === 'presence_leave'));
});

test('an action reaching another instance is forwarded to the connection', { skip: !REDIS_URL }, async () => {
  const alice = connect(first);
  const bob = connect(first);
  await first.handle(bob.id, { action: 'join', channel: 'forwarded' });

  // Alice's POSTs land on the second instance, her stream lives on the first
  await second.handle(alice.id, { action: 'join', channel: 'forwarded' });
  await waitFor(() => alice.events.some((event) => event.type === 'presence_state'));
  await second.handle(alice.id, { action: 'send', channel: 'forwarded', event: 'hello', payload: 'via redis' });

  await waitFor(() => bob.events.some((event) => event.type === 'broadcast'));
  assert.deepEqual(bob.events.find((event) => event.type === 'broadcast'), {
    type: 'broadcast', channel: 'forwarded', event: 'hello', payload: 'via redis',
  });
});
