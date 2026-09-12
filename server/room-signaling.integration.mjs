import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import {
  createRoomSignalingServer,
  MAX_MESSAGE_BYTES,
  MAX_SIGNAL_BYTES,
  ROOM_PROTOCOL,
} from "./room-signaling.mjs";

const ORIGIN = "http://localhost:1430";

async function setup(t, options = {}) {
  const service = createRoomSignalingServer({ port: 0, ...options });
  const address = await service.listen();
  t.after(() => service.close());
  return `ws://127.0.0.1:${address.port}/rooms`;
}

async function connect(t, url, options = {}) {
  const ws = new WebSocket(url, ROOM_PROTOCOL, { origin: ORIGIN, ...options });
  const queue = [];
  const waiting = [];
  ws.on("error", () => {});
  ws.on("message", (data) => {
    const value = JSON.parse(data.toString());
    const index = waiting.findIndex((pending) => pending.type === value.type);
    if (index < 0) queue.push(value);
    else {
      const [pending] = waiting.splice(index, 1);
      clearTimeout(pending.timer);
      pending.resolve(value);
    }
  });
  t.after(() => ws.terminate());
  await once(ws, "open");
  return {
    ws,
    send: (value) => ws.send(JSON.stringify(value)),
    next(type) {
      const index = queue.findIndex((item) => item.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const pending = {
          type,
          resolve,
          timer: setTimeout(() => {
            const index = waiting.indexOf(pending);
            if (index >= 0) waiting.splice(index, 1);
            reject(
              new Error(`Expected ${type}, received ${queue.map((item) => item.type).join()}`),
            );
          }, 2000),
        };
        waiting.push(pending);
      });
    },
  };
}

async function hostRoom(t, url) {
  const host = await connect(t, url);
  host.send({ type: "create", name: "Host AI" });
  const room = await host.next("created");
  return { host, room };
}

async function joinRoom(t, url, host, room) {
  const guest = await connect(t, url);
  guest.send({ type: "join", invitation: room.invitation, name: "Guest AI" });
  const requested = await guest.next("requested");
  const request = await host.next("request");
  return { guest, request, requested };
}

async function admit(host, guest, request) {
  host.send({ type: "accept", requestId: request.requestId });
  return Promise.all([host.next("admitted"), guest.next("admitted")]);
}

test("real sockets request admission, consume invitation, and relay one automatic offer/answer", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  assert.match(room.invitation, /^yri1_[\w-]{22}$/);
  assert.equal(Buffer.from(room.invitation.slice(5), "base64url").length, 16);
  const { guest, request, requested } = await joinRoom(t, url, host, room);
  assert.equal(requested.roomId, room.roomId);
  assert.equal(requested.remoteEndpointId, room.localEndpointId);
  assert.equal(request.endpointId, requested.localEndpointId);
  assert.equal(request.name, "Guest AI");
  const [hostAdmission, guestAdmission] = await admit(host, guest, request);
  assert.equal(hostAdmission.remoteEndpointId, guestAdmission.localEndpointId);
  assert.equal(hostAdmission.localEndpointId, guestAdmission.remoteEndpointId);
  assert.equal(hostAdmission.role, "host");
  assert.equal(guestAdmission.role, "guest");
  assert.equal(hostAdmission.roomId, room.roomId);
  assert.deepEqual(hostAdmission.iceServers, []);
  assert.deepEqual(guestAdmission.iceServers, []);
  const replay = await connect(t, url);
  replay.send({ type: "join", invitation: room.invitation, name: "Replay" });
  assert.equal((await replay.next("error")).code, "unavailable");
  const offer = JSON.stringify({ signal: "opaque offer\r\n", expiresAt: Date.now() + 1000 });
  host.send({ type: "signal", kind: "offer", data: offer });
  assert.deepEqual(await guest.next("signal"), { type: "signal", kind: "offer", data: offer });
  guest.send({ type: "signal", kind: "answer", data: "opaque answer" });
  assert.deepEqual(await host.next("signal"), {
    type: "signal",
    kind: "answer",
    data: "opaque answer",
  });
  host.send({ type: "ready" });
  await Promise.all([host.next("active"), guest.next("active")]);
  guest.send({ type: "leave" });
  assert.equal((await host.next("closed")).reason, "participant_left");
});

test("only one guest can request and a rejected guest cannot gain admission", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  const third = await connect(t, url);
  third.send({ type: "join", name: "Third", invitation: room.invitation });
  assert.equal((await third.next("error")).code, "busy");
  host.send({ type: "reject", requestId: request.requestId });
  assert.equal((await guest.next("closed")).reason, "declined");
  assert.equal((await host.next("request_cancelled")).requestId, request.requestId);
  const next = await joinRoom(t, url, host, room);
  assert.notEqual(next.request.requestId, request.requestId);
  host.send({ type: "accept", requestId: request.requestId });
  assert.equal((await host.next("error")).code, "protocol");
  await next.guest.next("closed");
});

test("guest cannot send SDP before admission and cancellation leaves the host waiting", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  guest.send({ type: "signal", kind: "offer", data: "not admitted" });
  assert.equal((await guest.next("error")).code, "protocol");
  assert.equal((await host.next("request_cancelled")).requestId, request.requestId);
  const next = await joinRoom(t, url, host, room);
  await admit(host, next.guest, next.request);
});

test("host socket owns admission and an admitted guest cannot offer or replay", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  await admit(host, guest, request);
  guest.send({ type: "signal", kind: "offer", data: "wrong role" });
  assert.equal((await guest.next("error")).code, "protocol");
  await host.next("closed");
});

test("a second offer invalidates both endpoints instead of replaying signaling", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  await admit(host, guest, request);
  host.send({ type: "signal", kind: "offer", data: "offer" });
  await guest.next("signal");
  host.send({ type: "signal", kind: "offer", data: "replay" });
  assert.equal((await host.next("error")).code, "protocol");
  await guest.next("closed");
});

test("host departure invalidates an invitation and closes its pending guest", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  const { guest } = await joinRoom(t, url, host, room);
  host.ws.close();
  assert.equal((await guest.next("closed")).reason, "participant_left");
  const replay = await connect(t, url);
  replay.send({ type: "join", invitation: room.invitation, name: "Replay" });
  assert.equal((await replay.next("error")).code, "unavailable");
});

test("expiration closes waiting rooms, and accepted rooms have a negotiation deadline", async (t) => {
  const url = await setup(t, { invitationTtlMs: 80, negotiationTtlMs: 50 });
  const first = await hostRoom(t, url);
  assert.equal((await first.host.next("closed")).reason, "expired");
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  await admit(host, guest, request);
  assert.equal((await host.next("closed")).reason, "timeout");
  assert.equal((await guest.next("closed")).reason, "timeout");
});

test("room capacity, unused connection timeout, and creation budget are enforced", async (t) => {
  const url = await setup(t, { maxRooms: 1, initialMessageTtlMs: 40, createBurst: 2 });
  await hostRoom(t, url);
  const second = await connect(t, url);
  second.send({ type: "create", name: "second" });
  assert.equal((await second.next("error")).code, "capacity");
  const third = await connect(t, url);
  third.send({ type: "create", name: "third" });
  assert.equal((await third.next("error")).code, "rate_limited");
  const idle = await connect(t, url);
  assert.equal((await idle.next("error")).code, "timeout");
});

test("message budget closes an abusive endpoint and revokes its room", async (t) => {
  const url = await setup(t, { messageBurst: 1, messagesPerSecond: 0.0001 });
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  host.send({ type: "accept", requestId: request.requestId });
  assert.equal((await host.next("error")).code, "rate_limited");
  await guest.next("closed");
});

test("signal and WebSocket frame byte limits reject oversized data", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  await admit(host, guest, request);
  host.send({ type: "signal", kind: "offer", data: "あ".repeat(Math.ceil(MAX_SIGNAL_BYTES / 3)) });
  assert.equal((await host.next("error")).code, "protocol");
  await guest.next("closed");
  const oversized = await connect(t, url);
  const closed = once(oversized.ws, "close");
  oversized.ws.send("x".repeat(MAX_MESSAGE_BYTES + 1));
  const [code] = await closed;
  assert.equal(code, 1009);
});

test("extra fields and binary messages are not accepted as room commands", async (t) => {
  const url = await setup(t);
  const extra = await connect(t, url);
  extra.send({ type: "create", name: "Host", roomId: "chosen-by-client" });
  assert.equal((await extra.next("error")).code, "protocol");
  const binary = await connect(t, url);
  binary.ws.send(Buffer.from('{"type":"create","name":"Host"}'));
  assert.equal((await binary.next("error")).code, "protocol");
});

async function rejection(url, { origin = ORIGIN, protocol = ROOM_PROTOCOL } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocol, origin ? { origin } : {});
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode);
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("Handshake should have been rejected"));
    });
    ws.on("error", () => {});
  });
}

test("exact origin, path, and subprotocol are mandatory; invite URL parameters are rejected", async (t) => {
  const url = await setup(t);
  assert.equal(await rejection(url, { origin: "https://untrusted.example" }), 403);
  assert.equal(await rejection(url, { origin: "null" }), 403);
  assert.equal(await rejection(url, { origin: "" }), 403);
  assert.equal(await rejection(url, { protocol: "other" }), 403);
  assert.equal(await rejection(`${url}?invitation=secret`), 403);
  assert.equal(await rejection(`${url}/other`), 403);
  const native = await connect(t, url, { origin: "tauri://localhost" });
  native.send({ type: "create", name: "Native" });
  await native.next("created");
});

test("upgrade and per-address connection limits apply without trusting forwarded headers", async (t) => {
  const url = await setup(t, { maxConnectionsPerAddress: 1 });
  await connect(t, url, { headers: { "X-Forwarded-For": "203.0.113.1" } });
  assert.equal(await rejection(url), 429);
  const other = await setup(t, { upgradeBurst: 1, upgradesPerSecond: 0.0001 });
  const first = await connect(t, other);
  first.ws.close();
  await once(first.ws, "close");
  assert.equal(await rejection(other), 429);
});

test("origin wildcards and invalid capacities are rejected at startup", () => {
  assert.throws(() => createRoomSignalingServer({ origins: ["*"] }), /exact origins/);
  assert.throws(() => createRoomSignalingServer({ maxRooms: 0 }), /Invalid/);
});

const TURN_SECRET = "integration-test-only-shared-secret-never-use-in-deployment";

test("only admission issues per-endpoint expiring coturn credentials; invitations and requests contain none", async (t) => {
  const stunUrls = ["stun:stun.example:3478"];
  const turnUrls = [
    "turn:turn.example:3478?transport=udp",
    "turns:turn.example:5349?transport=tcp",
  ];
  const url = await setup(t, { stunUrls, turnUrls, turnSharedSecret: TURN_SECRET });
  const { host, room } = await hostRoom(t, url);
  const { guest, request, requested } = await joinRoom(t, url, host, room);
  for (const value of [room, request, requested]) {
    assert.equal(Object.hasOwn(value, "iceServers"), false);
    assert.equal(JSON.stringify(value).includes(TURN_SECRET), false);
    assert.equal(JSON.stringify(value).includes("turn.example"), false);
  }
  assert.match(room.invitation, /^yri1_[\w-]{22}$/);
  const before = Math.floor(Date.now() / 1000);
  const admissions = await admit(host, guest, request);
  const after = Math.floor(Date.now() / 1000);
  for (const admission of admissions) {
    assert.deepEqual(admission.iceServers[0], { urls: stunUrls });
    const turn = admission.iceServers[1];
    assert.deepEqual(turn.urls, turnUrls);
    const [expires, roomId, endpointId] = turn.username.split(":");
    assert.ok(Number(expires) >= before + 3600 && Number(expires) <= after + 3600);
    assert.equal(roomId, room.roomId);
    assert.equal(endpointId, admission.localEndpointId);
    assert.equal(
      turn.credential,
      createHmac("sha1", TURN_SECRET).update(turn.username).digest("base64"),
    );
    assert.equal(JSON.stringify(admission).includes(TURN_SECRET), false);
    assert.deepEqual(Object.keys(turn).sort(), ["credential", "urls", "username"]);
  }
  assert.notEqual(admissions[0].iceServers[1].username, admissions[1].iceServers[1].username);
  assert.notEqual(admissions[0].iceServers[1].credential, admissions[1].iceServers[1].credential);
});

test("rejected guests receive no ICE and clients cannot supply ICE or TURN secrets", async (t) => {
  const url = await setup(t, {
    turnUrls: ["turn:turn.example:3478"],
    turnSharedSecret: TURN_SECRET,
  });
  const { host, room } = await hostRoom(t, url);
  const { guest, request } = await joinRoom(t, url, host, room);
  host.send({ type: "reject", requestId: request.requestId });
  assert.deepEqual(await guest.next("closed"), { type: "closed", reason: "declined" });
  await host.next("request_cancelled");
  const injected = await connect(t, url);
  injected.send({
    type: "join",
    name: "Other",
    invitation: room.invitation,
    iceServers: [{ urls: ["turn:attacker.example"] }],
    turnSharedSecret: "chosen-by-client",
  });
  assert.equal((await injected.next("error")).code, "protocol");
});

test("normalized duplicate resident names are rejected without reserving the guest slot", async (t) => {
  const url = await setup(t);
  const { host, room } = await hostRoom(t, url);
  for (const name of ["Host AI", " host ai ", "　ＨＯＳＴ ＡＩ　"]) {
    const duplicate = await connect(t, url);
    duplicate.send({ type: "join", name, invitation: room.invitation });
    assert.equal((await duplicate.next("error")).code, "duplicate_name");
  }
  const { guest, request } = await joinRoom(t, url, host, room);
  await admit(host, guest, request);
});

test("invalid ICE/secret/TTL settings fail at startup without echoing configuration values", () => {
  for (const options of [
    { stunUrls: "stun:stun.example" },
    { stunUrls: ["https://stun.example"] },
    { stunUrls: ["stun:stun.example?transport=udp"] },
    { stunUrls: Array.from({ length: 5 }, (_, index) => `stun:host${index}.example`) },
    { stunUrls: ["stun:stun.example", "stun:stun.example"] },
    { turnUrls: ["turn:user:password@turn.example"], turnSharedSecret: TURN_SECRET },
    { turnUrls: ["turn:turn.example/path"], turnSharedSecret: TURN_SECRET },
    { turnUrls: ["turn:turn.example:99999"], turnSharedSecret: TURN_SECRET },
    { turnUrls: ["turn:turn.example:0"], turnSharedSecret: TURN_SECRET },
    { turnUrls: ["turn:turn.example"], turnSharedSecret: "" },
    { turnSharedSecret: TURN_SECRET },
    { turnUrls: ["turn:turn.example"], turnSharedSecret: "short" },
    { turnUrls: ["turn:turn.example"], turnSharedSecret: "x".repeat(257) },
    { turnCredentialTtlSeconds: 2099 },
    { turnCredentialTtlSeconds: 3601 },
    { turnCredentialTtlSeconds: 2100.5 },
  ]) {
    assert.throws(
      () => createRoomSignalingServer(options),
      (error) => {
        assert.match(error.message, /Invalid/);
        assert.equal(error.message.includes(TURN_SECRET), false);
        assert.equal(error.message.includes("password"), false);
        return true;
      },
    );
  }
});
