// Syncropy relay: pairs exactly two peers (host + viewer) into one room and
// relays messages between them (WebRTC SDP/ICE signaling, or anything else
// two peers need to exchange). The relay never inspects message content -
// it's a dumb pipe, so it works the same whether the payload is a screen
// share handshake or, later, remote-control input.

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // role ("host" | "viewer") -> WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "viewer") {
      return new Response("role must be 'host' or 'viewer'", { status: 400 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // A role reconnecting (e.g. viewer refresh) replaces its old socket.
    const existing = this.sockets.get(role);
    if (existing) {
      try { existing.close(1000, "replaced by new connection"); } catch {}
    }
    this.sockets.set(role, server);

    const other = role === "host" ? "viewer" : "host";

    server.addEventListener("message", (event) => {
      const peer = this.sockets.get(other);
      if (peer && peer.readyState === WebSocket.READY_STATE_OPEN) {
        peer.send(event.data);
      }
    });

    const cleanup = () => {
      if (this.sockets.get(role) === server) this.sockets.delete(role);
      const peer = this.sockets.get(other);
      if (peer && peer.readyState === WebSocket.READY_STATE_OPEN) {
        peer.send(JSON.stringify({ type: "peer-left", role }));
      }
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    // Tell the newly-joined peer whether the other side is already present.
    server.send(JSON.stringify({ type: "joined", role, peerPresent: this.sockets.has(other) }));
    const peer = this.sockets.get(other);
    if (peer && peer.readyState === WebSocket.READY_STATE_OPEN) {
      peer.send(JSON.stringify({ type: "peer-joined", role }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "syncropy-relay" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const authMatch = url.pathname.match(/^\/relay\/([A-Za-z0-9_-]{6,128})$/);
    if (authMatch) {
      const room = authMatch[1];
      const key = url.searchParams.get("key");
      if (!env.RELAY_PSK || key !== env.RELAY_PSK) {
        return new Response("unauthorized", { status: 401 });
      }
      const id = env.ROOM.idFromName(room);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // Public pairing path for the connect.html client demo: no shared PSK
    // (there's no way to hand a server secret to an anonymous browser
    // client without publishing it), so the room code itself - a
    // high-entropy client-generated UUID, required to be at least 20 chars
    // here - is the only thing standing between two strangers and a room.
    // Kept as a distinct DO namespace ("pair:" prefix) so it can never
    // collide with an authenticated /relay/ room.
    const publicMatch = url.pathname.match(/^\/pair\/([A-Za-z0-9_-]{20,128})$/);
    if (publicMatch) {
      const id = env.ROOM.idFromName(`pair:${publicMatch[1]}`);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("expected /relay/:room or /pair/:room", { status: 404 });
  },
};
