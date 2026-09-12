import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

export const ROOM_PROTOCOL = "yorishiro-room-v1";
export const MAX_SIGNAL_BYTES = 140 * 1024;
export const MAX_MESSAGE_BYTES = 192 * 1024;
const INVITATION = /^yri1_[A-Za-z0-9_-]{22}$/;
const DEFAULT_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "http://localhost:1430",
  "http://127.0.0.1:1430",
];

function token(bytes = 16) {
  return randomBytes(bytes).toString("base64url");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shape(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...fields].sort().join()
  );
}

function validName(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 64 &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}

function normalizedName(value) {
  return value.normalize("NFKC").trim().toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ");
}

function iceUrls(value, kind) {
  const fail = () => {
    throw new Error(`Invalid room signaling ${kind} URLs`);
  };
  if (!Array.isArray(value) || value.length > 4) fail();
  const urls = [];
  for (const url of value) {
    if (typeof url !== "string" || url.length > 256) fail();
    const match =
      /^(stuns?|turns?):((?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?)(?:\?transport=(udp|tcp))?$/.exec(
        url,
      );
    if (!match?.[1].startsWith(kind) || (kind === "stun" && match[3])) fail();
    try {
      const parsed = new URL(`https://${match[2]}`);
      if (
        !parsed.hostname ||
        parsed.port === "0" ||
        (!parsed.hostname.startsWith("[") &&
          parsed.hostname
            .replace(/\.$/, "")
            .split(".")
            .some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))
      )
        fail();
    } catch {
      fail();
    }
    if (urls.includes(url)) fail();
    urls.push(url);
  }
  return Object.freeze(urls);
}

function budget(burst) {
  return { tokens: burst, at: Date.now() };
}

function consume(value, burst, perSecond) {
  const now = Date.now();
  value.tokens = Math.min(burst, value.tokens + (Math.max(0, now - value.at) * perSecond) / 1000);
  value.at = now;
  if (value.tokens < 1) return false;
  value.tokens -= 1;
  return true;
}

/**
 * Ephemeral, two-endpoint admission and SDP relay. Socket ownership authenticates
 * the host; the 128-bit invitation only allows a request, never direct admission.
 * No accounts, persistent state, media, message body logging, or proxy-header trust.
 */
export function createRoomSignalingServer(options = {}) {
  const settings = {
    host: "127.0.0.1",
    port: 1531,
    origins: DEFAULT_ORIGINS,
    invitationTtlMs: 5 * 60_000,
    negotiationTtlMs: 120_000,
    sessionTtlMs: 4 * 60 * 60_000,
    initialMessageTtlMs: 10_000,
    heartbeatMs: 30_000,
    maxRooms: 128,
    maxConnections: 512,
    maxConnectionsPerAddress: 32,
    maxAddresses: 4096,
    maxRequestsPerRoom: 12,
    messageBurst: 12,
    messagesPerSecond: 2,
    upgradeBurst: 60,
    upgradesPerSecond: 1,
    createBurst: 12,
    createsPerSecond: 0.2,
    stunUrls: [],
    turnUrls: [],
    turnSharedSecret: "",
    turnCredentialTtlSeconds: 3600,
    ...options,
  };
  for (const [key, value] of Object.entries(settings)) {
    if (
      !["host", "origins", "stunUrls", "turnUrls", "turnSharedSecret"].includes(key) &&
      (typeof value !== "number" || !Number.isFinite(value) || value < (key === "port" ? 0 : 1e-6))
    )
      throw new Error(`Invalid room signaling setting: ${key}`);
  }
  const stunUrls = iceUrls(settings.stunUrls, "stun");
  const turnUrls = iceUrls(settings.turnUrls, "turn");
  if (
    typeof settings.turnSharedSecret !== "string" ||
    (turnUrls.length > 0
      ? settings.turnSharedSecret.length < 32 ||
        settings.turnSharedSecret.length > 256 ||
        Array.from(settings.turnSharedSecret).some(
          (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126,
        )
      : settings.turnSharedSecret !== "") ||
    !Number.isInteger(settings.turnCredentialTtlSeconds) ||
    settings.turnCredentialTtlSeconds < 2100 ||
    settings.turnCredentialTtlSeconds > 3600
  )
    throw new Error("Invalid room signaling TURN credential configuration");
  if (
    !Array.isArray(settings.origins) ||
    settings.origins.length === 0 ||
    settings.origins.some(
      (origin) =>
        typeof origin !== "string" ||
        !/^(https?:\/\/[^/?#\s]+|tauri:\/\/localhost)$/.test(origin) ||
        origin.includes("*") ||
        origin.includes("@"),
    )
  )
    throw new Error("ROOM_SIGNALING_ORIGINS must contain exact origins, without wildcards");
  const origins = new Set(settings.origins);
  const rooms = new Set();
  const invitations = new Map();
  const addresses = new Map();
  let disposed = false;
  let closing;
  const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
    response.end("Not found\n");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(ROOM_PROTOCOL) ? ROOM_PROTOCOL : false),
  });

  function admittedIceServers(room, participant) {
    const servers = [];
    if (stunUrls.length) servers.push({ urls: [...stunUrls] });
    if (turnUrls.length) {
      // Coturn TURN REST: expiry:opaque-room:opaque-endpoint, signed with the server-only secret.
      const expires = Math.floor(Date.now() / 1000) + settings.turnCredentialTtlSeconds;
      const username = `${expires}:${room.id}:${participant.id}`;
      const credential = createHmac("sha1", settings.turnSharedSecret)
        .update(username)
        .digest("base64");
      servers.push({ urls: [...turnUrls], username, credential });
    }
    return servers;
  }

  function send(client, message) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > MAX_MESSAGE_BYTES * 2) {
      client.ws.terminate();
      return;
    }
    client.ws.send(JSON.stringify(message), (error) => {
      if (error) client.ws.terminate();
    });
  }

  function finish(client, reason) {
    if (client.done) return;
    client.done = true;
    clearTimeout(client.initialTimer);
    send(client, { type: "closed", reason });
    client.ws.close(1000, reason);
    // A peer which ignores the close frame cannot retain a connection slot.
    const deadline = setTimeout(() => client.ws.terminate(), 1000);
    deadline.unref();
    client.ws.once("close", () => clearTimeout(deadline));
  }

  function closeRoom(room, reason) {
    if (!rooms.delete(room)) return;
    clearTimeout(room.timer);
    invitations.delete(room.invitationHash);
    room.phase = "closed";
    room.host.room = null;
    if (room.guest) room.guest.room = null;
    finish(room.host, reason);
    if (room.guest) finish(room.guest, reason);
  }

  function deadline(room, ttl, reason) {
    clearTimeout(room.timer);
    room.timer = setTimeout(() => closeRoom(room, reason), ttl);
    room.timer.unref();
  }

  function invalid(client, reason = "protocol") {
    send(client, { type: "error", code: reason });
    finish(client, reason);
    if (client.room) leave(client);
  }

  function leave(client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    if (client === room.host || room.phase !== "waiting") {
      closeRoom(room, "participant_left");
    } else if (room.guest === client) {
      room.guest = null;
      const requestId = room.requestId;
      room.requestId = null;
      send(room.host, { type: "request_cancelled", requestId });
    }
  }

  function receive(client, data, binary) {
    if (client.done) return;
    if (!consume(client.budget, settings.messageBurst, settings.messagesPerSecond)) {
      invalid(client, "rate_limited");
      return;
    }
    if (binary || data.length > MAX_MESSAGE_BYTES) {
      invalid(client);
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      invalid(client);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      invalid(client);
      return;
    }
    if (message.type === "leave" && shape(message, ["type"])) {
      leave(client);
      finish(client, "closed");
      return;
    }
    if (client.role === null) {
      clearTimeout(client.initialTimer);
      if (
        message.type === "create" &&
        shape(message, ["type", "name"]) &&
        validName(message.name)
      ) {
        if (!consume(client.address.creates, settings.createBurst, settings.createsPerSecond)) {
          invalid(client, "rate_limited");
          return;
        }
        if (rooms.size >= settings.maxRooms) {
          invalid(client, "capacity");
          return;
        }
        const invitation = `yri1_${token()}`;
        const room = {
          id: randomUUID(),
          host: client,
          guest: null,
          requestId: null,
          requests: 0,
          invitationHash: digest(invitation),
          expiresAt: Date.now() + settings.invitationTtlMs,
          phase: "waiting",
          timer: null,
        };
        client.role = "host";
        client.name = message.name.trim();
        client.room = room;
        rooms.add(room);
        invitations.set(room.invitationHash, room);
        deadline(room, settings.invitationTtlMs, "expired");
        send(client, {
          type: "created",
          invitation,
          expiresAt: room.expiresAt,
          roomId: room.id,
          localEndpointId: client.id,
        });
        return;
      }
      if (
        message.type === "join" &&
        shape(message, ["type", "name", "invitation"]) &&
        validName(message.name) &&
        typeof message.invitation === "string" &&
        INVITATION.test(message.invitation)
      ) {
        const room = invitations.get(digest(message.invitation));
        if (!room || room.expiresAt <= Date.now() || room.phase !== "waiting") {
          invalid(client, "unavailable");
          return;
        }
        if (normalizedName(message.name) === normalizedName(room.host.name)) {
          invalid(client, "duplicate_name");
          return;
        }
        if (room.guest || room.requests >= settings.maxRequestsPerRoom) {
          invalid(client, "busy");
          return;
        }
        client.name = message.name.trim();
        client.role = "guest";
        client.room = room;
        room.guest = client;
        room.requestId = token(12);
        room.requests++;
        send(client, {
          type: "requested",
          hostName: room.host.name,
          expiresAt: room.expiresAt,
          roomId: room.id,
          localEndpointId: client.id,
          remoteEndpointId: room.host.id,
        });
        send(room.host, {
          type: "request",
          requestId: room.requestId,
          name: client.name,
          endpointId: client.id,
        });
        return;
      }
      invalid(client);
      return;
    }
    const room = client.room;
    if (!room || !rooms.has(room)) {
      invalid(client);
      return;
    }
    if (
      client === room.host &&
      room.phase === "waiting" &&
      (message.type === "accept" || message.type === "reject") &&
      shape(message, ["type", "requestId"]) &&
      room.guest &&
      message.requestId === room.requestId
    ) {
      if (room.expiresAt <= Date.now()) {
        closeRoom(room, "expired");
        return;
      }
      if (message.type === "reject") {
        const guest = room.guest;
        guest.room = null;
        room.guest = null;
        const requestId = room.requestId;
        room.requestId = null;
        finish(guest, "declined");
        send(room.host, { type: "request_cancelled", requestId });
      } else {
        invitations.delete(room.invitationHash); // Acceptance consumes the invitation permanently.
        room.phase = "offer";
        deadline(room, settings.negotiationTtlMs, "timeout");
        for (const participant of [room.host, room.guest]) {
          const other = participant === room.host ? room.guest : room.host;
          send(participant, {
            type: "admitted",
            role: participant.role,
            name: other.name,
            roomId: room.id,
            localEndpointId: participant.id,
            remoteEndpointId: other.id,
            iceServers: admittedIceServers(room, participant),
          });
        }
      }
      return;
    }
    if (
      message.type === "signal" &&
      shape(message, ["type", "kind", "data"]) &&
      typeof message.data === "string" &&
      message.data.length > 0 &&
      Buffer.byteLength(message.data, "utf8") <= MAX_SIGNAL_BYTES
    ) {
      if (client === room.host && room.phase === "offer" && message.kind === "offer") {
        room.phase = "answer";
        send(room.guest, { type: "signal", kind: "offer", data: message.data });
        return;
      }
      if (client === room.guest && room.phase === "answer" && message.kind === "answer") {
        room.phase = "ready";
        send(room.host, { type: "signal", kind: "answer", data: message.data });
        return;
      }
    }
    if (
      message.type === "ready" &&
      shape(message, ["type"]) &&
      client === room.host &&
      room.phase === "ready"
    ) {
      room.phase = "active";
      deadline(room, settings.sessionTtlMs, "expired");
      send(room.host, { type: "active" });
      send(room.guest, { type: "active" });
      return;
    }
    // Replayed admission, offers, answers, or messages from the wrong role close the room.
    invalid(client);
  }

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    const deny = (status) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (
      disposed ||
      request.method !== "GET" ||
      request.url !== "/rooms" ||
      !origins.has(request.headers.origin) ||
      request.headers["sec-websocket-protocol"] !== ROOM_PROTOCOL
    ) {
      deny("403 Forbidden");
      return;
    }
    const key = socket.remoteAddress;
    let address = addresses.get(key);
    if (!address) {
      if (addresses.size >= settings.maxAddresses) {
        deny("503 Service Unavailable");
        return;
      }
      address = {
        connections: 0,
        touched: Date.now(),
        upgrades: budget(settings.upgradeBurst),
        creates: budget(settings.createBurst),
      };
      addresses.set(key, address);
    }
    address.touched = Date.now();
    if (
      websocket.clients.size >= settings.maxConnections ||
      address.connections >= settings.maxConnectionsPerAddress ||
      !consume(address.upgrades, settings.upgradeBurst, settings.upgradesPerSecond)
    ) {
      deny("429 Too Many Requests");
      return;
    }
    websocket.handleUpgrade(request, socket, head, (ws) => {
      address.connections++;
      const client = {
        id: randomUUID(),
        ws,
        address,
        role: null,
        room: null,
        name: "",
        done: false,
        alive: true,
        budget: budget(settings.messageBurst),
        initialTimer: null,
      };
      ws.roomClient = client;
      client.initialTimer = setTimeout(
        () => invalid(client, "timeout"),
        settings.initialMessageTtlMs,
      );
      client.initialTimer.unref();
      ws.on("message", (data, binary) => receive(client, data, binary));
      ws.on("pong", () => {
        client.alive = true;
      });
      ws.on("ping", () => {
        if (!consume(client.budget, settings.messageBurst, settings.messagesPerSecond))
          invalid(client, "rate_limited");
      });
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        clearTimeout(client.initialTimer);
        address.connections--;
        address.touched = Date.now();
        leave(client);
        client.done = true;
      });
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  const heartbeat = setInterval(() => {
    for (const ws of websocket.clients) {
      if (!ws.roomClient.alive) ws.terminate();
      else {
        ws.roomClient.alive = false;
        ws.ping();
      }
    }
    for (const [key, address] of addresses) {
      if (address.connections === 0 && Date.now() - address.touched > 5 * 60_000)
        addresses.delete(key);
    }
  }, settings.heartbeatMs);
  heartbeat.unref();

  return {
    server,
    listen() {
      return new Promise((fulfill, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(settings.port, settings.host, () => {
          server.off("error", onError);
          fulfill(server.address());
        });
      });
    },
    close() {
      if (closing) return closing;
      disposed = true;
      clearInterval(heartbeat);
      for (const room of rooms) closeRoom(room, "closed");
      for (const ws of websocket.clients) ws.terminate();
      websocket.close();
      addresses.clear();
      closing = new Promise((fulfill) => server.close(() => fulfill()));
      return closing;
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const service = createRoomSignalingServer({
    host: process.env.ROOM_SIGNALING_HOST || "127.0.0.1",
    port: Number(process.env.ROOM_SIGNALING_PORT || 1531),
    ...(process.env.ROOM_SIGNALING_ORIGINS
      ? { origins: process.env.ROOM_SIGNALING_ORIGINS.split(",").map((origin) => origin.trim()) }
      : {}),
    stunUrls: process.env.ROOM_SIGNALING_STUN_URLS?.split(",").map((url) => url.trim()) ?? [],
    turnUrls: process.env.ROOM_SIGNALING_TURN_URLS?.split(",").map((url) => url.trim()) ?? [],
    turnSharedSecret: process.env.ROOM_SIGNALING_TURN_SHARED_SECRET ?? "",
    turnCredentialTtlSeconds: Number(
      process.env.ROOM_SIGNALING_TURN_CREDENTIAL_TTL_SECONDS ?? 3600,
    ),
  });
  try {
    const address = await service.listen();
    console.info(`Room signaling listening on ${address.address}:${address.port}/rooms`);
    console.info(
      "Internet use requires a reachable WSS endpoint and configured WebRTC ICE servers.",
    );
    process.once("SIGINT", () => void service.close());
    process.once("SIGTERM", () => void service.close());
  } catch {
    console.error("Room signaling could not listen. Check its bind address and port.");
    await service.close();
    process.exitCode = 1;
  }
}
