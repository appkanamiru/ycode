import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryBackend, type RealtimeBackend } from './backends';
import { RealtimeHub } from './hub';
import type { RealtimeEvent } from './protocol';
import { issueRealtimeToken, verifyRealtimeToken } from './token';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function connect(hub: RealtimeHub, tenantId: string | null, userId = 'user') {
  const events: RealtimeEvent[] = [];
  const id = hub.connect(tenantId, userId, (event) => events.push(event));
  return { id, events, of: (type: RealtimeEvent['type']) => events.filter((event) => event.type === type) };
}

function withHub(fn: (hub: RealtimeHub, backend: RealtimeBackend) => Promise<void>) {
  return async () => {
    const backend = createMemoryBackend();
    const hub = new RealtimeHub(backend);
    try {
      await fn(hub, backend);
    } finally {
      await hub.stop();
    }
  };
}

test('broadcasts reach other members of the channel, not the sender', withHub(async (hub) => {
  const alice = connect(hub, TENANT_A);
  const bob = connect(hub, TENANT_A);
  const outsider = connect(hub, TENANT_A);
  await hub.handle(alice.id, { action: 'join', channel: 'pages:updates' });
  await hub.handle(bob.id, { action: 'join', channel: 'pages:updates' });
  await hub.handle(outsider.id, { action: 'join', channel: 'fonts:updates' });

  await hub.handle(alice.id, { action: 'send', channel: 'pages:updates', event: 'page_updated', payload: { id: 'p1' } });

  assert.deepEqual(bob.of('broadcast'), [{ type: 'broadcast', channel: 'pages:updates', event: 'page_updated', payload: { id: 'p1' } }]);
  assert.deepEqual(alice.of('broadcast'), []);
  assert.deepEqual(outsider.of('broadcast'), []);
}));

test('channels are scoped to the tenant', withHub(async (hub) => {
  const acme = connect(hub, TENANT_A);
  const beta = connect(hub, TENANT_B);
  await hub.handle(acme.id, { action: 'join', channel: 'pages:updates' });
  await hub.handle(beta.id, { action: 'join', channel: 'pages:updates' });
  await hub.handle(beta.id, { action: 'track', channel: 'pages:updates', state: { name: 'Beta' } });

  await hub.handle(acme.id, { action: 'send', channel: 'pages:updates', event: 'page_updated', payload: {} });
  await hub.publishFromServer(TENANT_A, 'pages:updates', 'page_created', {});

  assert.equal(beta.of('broadcast').length, 0);
  assert.equal(acme.of('presence_join').length, 0, 'Beta\'s presence is not visible to Acme');
  assert.equal(acme.of('broadcast').length, 1, 'server broadcast reaches the tenant');
}));

test('presence: state on join, join and leave events, cleanup on disconnect', withHub(async (hub) => {
  const alice = connect(hub, TENANT_A);
  await hub.handle(alice.id, { action: 'join', channel: 'room' });
  await hub.handle(alice.id, { action: 'track', channel: 'room', state: { name: 'Alice' } });

  const bob = connect(hub, TENANT_A);
  await hub.handle(bob.id, { action: 'join', channel: 'room' });
  assert.deepEqual(bob.of('presence_state'), [{ type: 'presence_state', channel: 'room', presences: { [alice.id]: { name: 'Alice' } } }]);

  await hub.handle(bob.id, { action: 'track', channel: 'room', state: { name: 'Bob' } });
  assert.deepEqual(alice.of('presence_join').map((event) => event.type === 'presence_join' && event.state), [{ name: 'Alice' }, { name: 'Bob' }]);

  await hub.disconnect(bob.id);
  assert.deepEqual(alice.of('presence_leave'), [{ type: 'presence_leave', channel: 'room', key: bob.id, state: { name: 'Bob' } }]);

  const carol = connect(hub, TENANT_A);
  await hub.handle(carol.id, { action: 'join', channel: 'room' });
  assert.deepEqual(Object.keys((carol.of('presence_state')[0] as { presences: object }).presences), [alice.id]);
}));

test('actions are validated', withHub(async (hub) => {
  const alice = connect(hub, TENANT_A);
  await assert.rejects(hub.handle(alice.id, { action: 'send', channel: 'room', event: 'x', payload: {} }), /Not joined/);
  await assert.rejects(hub.handle(alice.id, { action: 'join', channel: 'bad channel!' }), /Invalid channel/);
  await hub.handle(alice.id, { action: 'join', channel: 'room' });
  await assert.rejects(hub.handle(alice.id, { action: 'send', channel: 'room', event: '', payload: {} }), /Invalid event/);
  await assert.rejects(hub.handle(alice.id, { action: 'track', channel: 'room', state: [] as never }), /Invalid presence/);
}));

test('connection tokens are signed and expire', () => {
  process.env.REALTIME_SECRET = 'test-secret';
  const claims = { connectionId: 'c1', tenantId: TENANT_A, userId: 'u1' };

  const token = issueRealtimeToken(claims);
  assert.deepEqual({ ...verifyRealtimeToken(token), expires: undefined }, { ...claims, expires: undefined });

  const [body, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, tenantId: TENANT_B, expires: Date.now() + 1000 })).toString('base64url');
  assert.equal(verifyRealtimeToken(`${forged}.${signature}`), null, 'tampered claims');
  assert.equal(verifyRealtimeToken(`${body}.x${signature}`), null, 'tampered signature');
  assert.equal(verifyRealtimeToken(issueRealtimeToken(claims, -1)), null, 'expired');
  assert.equal(verifyRealtimeToken(null), null);
});
