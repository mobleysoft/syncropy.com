// Real functional tests for relay-worker/src/index.js - the Durable Object
// signaling relay that both syncropy.com's public /pair/ pairing demo and
// the authenticated /relay/ path depend on. Had zero test coverage before
// this pass (same gap class already found and fixed for
// weyland-audiovizai-worker/nginx's av-treatment endpoints elsewhere in
// this portfolio - untested Worker logic that shipped real bugs silently
// for days before a manual curl caught them). Uses node's built-in test
// runner only, no new dependencies, mocking the two Cloudflare-Workers-only
// globals (WebSocketPair, WebSocket.READY_STATE_OPEN) the real code needs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class MockSocket {
  constructor() {
    this.listeners = {};
    this.readyState = 1; // OPEN
    this.sent = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
  }
  accept() {}
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
    this.dispatch('close', {});
  }
}

globalThis.__mockPairs = [];
globalThis.WebSocketPair = class {
  constructor() {
    const client = new MockSocket();
    const server = new MockSocket();
    this[0] = client;
    this[1] = server;
    globalThis.__mockPairs.push({ client, server });
  }
};
globalThis.WebSocket = { READY_STATE_OPEN: 1 };

// Node's built-in Response (undici) rejects status 101 by spec - it's a
// Workers-runtime-only special case for the WebSocket upgrade response
// (new Response(null, {status: 101, webSocket: client})). Real code under
// test relies on exactly this, so give it a minimal pass-through here;
// every other status still goes through the real Response class untouched.
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      return { status: 101, webSocket: init.webSocket };
    }
    super(body, init);
  }
};

const { default: worker, RelayRoom } = await import('../src/index.js');

function makeMockRoomBinding() {
  const calls = [];
  const binding = {
    idFromName(name) {
      calls.push({ op: 'idFromName', name });
      return { __id: name };
    },
    get(id) {
      calls.push({ op: 'get', id: id.__id });
      return {
        async fetch(request) {
          calls.push({ op: 'stub.fetch', url: request.url });
          return new Response('stub-ok', { status: 200 });
        },
      };
    },
  };
  return { binding, calls };
}

// --- default export routing ---

test('GET / returns real health JSON', async () => {
  const res = await worker.fetch(new Request('https://syncropy-relay.example/'), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: 'ok', service: 'syncropy-relay' });
});

test('GET /health returns the same health JSON', async () => {
  const res = await worker.fetch(new Request('https://syncropy-relay.example/health'), {});
  assert.equal(res.status, 200);
});

test('unknown path returns 404', async () => {
  const res = await worker.fetch(new Request('https://syncropy-relay.example/nope'), {});
  assert.equal(res.status, 404);
});

test('/relay/:room with too-short room id does not match and 404s', async () => {
  const res = await worker.fetch(new Request('https://syncropy-relay.example/relay/ab'), {});
  assert.equal(res.status, 404);
});

test('/relay/:room with no key is rejected 401 and never reaches the DO', async () => {
  const { binding, calls } = makeMockRoomBinding();
  const env = { RELAY_PSK: 'right-secret', ROOM: binding };
  const res = await worker.fetch(new Request('https://syncropy-relay.example/relay/some-private-room'), env);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, 'unauthorized request must not touch the Durable Object');
});

test('/relay/:room with wrong key is rejected 401', async () => {
  const { binding, calls } = makeMockRoomBinding();
  const env = { RELAY_PSK: 'right-secret', ROOM: binding };
  const res = await worker.fetch(
    new Request('https://syncropy-relay.example/relay/some-private-room?key=wrong-secret'),
    env
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('/relay/:room with correct key routes to the DO under the PLAIN room name (no prefix)', async () => {
  const { binding, calls } = makeMockRoomBinding();
  const env = { RELAY_PSK: 'right-secret', ROOM: binding };
  const res = await worker.fetch(
    new Request('https://syncropy-relay.example/relay/some-private-room?key=right-secret'),
    env
  );
  assert.equal(res.status, 200);
  const idCall = calls.find((c) => c.op === 'idFromName');
  assert.equal(idCall.name, 'some-private-room');
});

test('/pair/:room with a room code under 20 chars 404s (too low-entropy to trust)', async () => {
  const { binding, calls } = makeMockRoomBinding();
  const env = { ROOM: binding };
  const res = await worker.fetch(new Request('https://syncropy-relay.example/pair/tooshort'), env);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('/pair/:room with a valid code routes to the DO under a "pair:"-PREFIXED name', async () => {
  const { binding, calls } = makeMockRoomBinding();
  const env = { ROOM: binding };
  const room = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'; // real connect.html crypto.randomUUID() shape
  const res = await worker.fetch(new Request(`https://syncropy-relay.example/pair/${room}`), env);
  assert.equal(res.status, 200);
  const idCall = calls.find((c) => c.op === 'idFromName');
  assert.equal(idCall.name, `pair:${room}`);
});

test('/pair/ and /relay/ can never collide on the same DO namespace even with the same room string', async () => {
  const { binding, calls } = makeMockRoomBinding();
  const env = { RELAY_PSK: 'k', ROOM: binding };
  const shared = 'shared-room-name-123456789012345';
  await worker.fetch(new Request(`https://syncropy-relay.example/relay/${shared}?key=k`), env);
  await worker.fetch(new Request(`https://syncropy-relay.example/pair/${shared}`), env);
  const names = calls.filter((c) => c.op === 'idFromName').map((c) => c.name);
  assert.deepEqual(names, [shared, `pair:${shared}`]);
  assert.notEqual(names[0], names[1]);
});

// --- RelayRoom Durable Object: the actual relaying logic ---

function wsRequest(role) {
  return new Request(`https://relay.example/room?role=${role}`, {
    headers: { Upgrade: 'websocket' },
  });
}

test('RelayRoom rejects a missing/invalid role with 400', async () => {
  const room = new RelayRoom({}, {});
  const res = await room.fetch(new Request('https://relay.example/room?role=bogus', { headers: { Upgrade: 'websocket' } }));
  assert.equal(res.status, 400);
});

test('RelayRoom rejects a non-websocket request with 426', async () => {
  const room = new RelayRoom({}, {});
  const res = await room.fetch(new Request('https://relay.example/room?role=host'));
  assert.equal(res.status, 426);
});

test('RelayRoom: host connecting alone gets peerPresent:false', async () => {
  const room = new RelayRoom({}, {});
  globalThis.__mockPairs.length = 0;
  const res = await room.fetch(wsRequest('host'));
  assert.equal(res.status, 101);
  const { server } = globalThis.__mockPairs.at(-1);
  const joined = JSON.parse(server.sent[0]);
  assert.deepEqual(joined, { type: 'joined', role: 'host', peerPresent: false });
});

test('RelayRoom: viewer joining after host sees peerPresent:true, and host gets peer-joined', async () => {
  const room = new RelayRoom({}, {});
  globalThis.__mockPairs.length = 0;
  await room.fetch(wsRequest('host'));
  const hostServer = globalThis.__mockPairs.at(-1).server;

  await room.fetch(wsRequest('viewer'));
  const viewerServer = globalThis.__mockPairs.at(-1).server;

  const viewerJoined = JSON.parse(viewerServer.sent[0]);
  assert.deepEqual(viewerJoined, { type: 'joined', role: 'viewer', peerPresent: true });

  const hostSawPeerJoined = hostServer.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'peer-joined');
  assert.deepEqual(hostSawPeerJoined, { type: 'peer-joined', role: 'viewer' });
});

test('RelayRoom: a message from one role is relayed verbatim to the other, and NOT echoed back to itself', async () => {
  const room = new RelayRoom({}, {});
  globalThis.__mockPairs.length = 0;
  await room.fetch(wsRequest('host'));
  const hostServer = globalThis.__mockPairs.at(-1).server;
  await room.fetch(wsRequest('viewer'));
  const viewerServer = globalThis.__mockPairs.at(-1).server;

  const before = viewerServer.sent.length;
  const offer = JSON.stringify({ type: 'offer', sdp: { type: 'offer', sdp: 'v=0 test' } });
  hostServer.dispatch('message', { data: offer });

  assert.equal(viewerServer.sent.length, before + 1);
  assert.equal(viewerServer.sent.at(-1), offer);
  assert.ok(!hostServer.sent.includes(offer), 'sender must never receive its own message back');
});

test('RelayRoom: a role reconnecting replaces the old socket and closes it', async () => {
  const room = new RelayRoom({}, {});
  globalThis.__mockPairs.length = 0;
  await room.fetch(wsRequest('viewer'));
  const firstViewerServer = globalThis.__mockPairs.at(-1).server;

  await room.fetch(wsRequest('viewer'));

  assert.equal(firstViewerServer.closed, true);
  assert.equal(firstViewerServer.closeCode, 1000);
});

test('RelayRoom: when one side disconnects, the other gets a real peer-left message', async () => {
  const room = new RelayRoom({}, {});
  globalThis.__mockPairs.length = 0;
  await room.fetch(wsRequest('host'));
  const hostServer = globalThis.__mockPairs.at(-1).server;
  await room.fetch(wsRequest('viewer'));
  const viewerServer = globalThis.__mockPairs.at(-1).server;

  viewerServer.dispatch('close', {});

  const peerLeft = hostServer.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'peer-left');
  assert.deepEqual(peerLeft, { type: 'peer-left', role: 'viewer' });
});
