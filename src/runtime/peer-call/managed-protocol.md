# Managed calling protocol v2

Client compatibility copy of `Yorishiro-peer-call-server/PROTOCOL.md`. Update both repositories when the wire contract changes. The server repository and its publication/license policy are maintained separately.

This is the shared implementation contract. Existing development `/rooms` v1 remains supported independently. The managed endpoint ends in `/v2/rooms`.

## Authentication and identity

- P-256 ECDSA SHA-256 device keypair, private CryptoKey nonextractable in endpoint-scoped IndexedDB. Public key is raw 65-byte SEC1, base64url without padding. Identity ID is base64url SHA-256 of that raw public key (43 characters).
- Every socket must authenticate before other commands. Server sends `{type:"challenge", challenge:<32 random bytes base64url>}` once.
- Client replies `{type:"authenticate", publicKey, signature}`. Signature is 64-byte IEEE P1363 ECDSA, base64url, over UTF-8 `yorishiro-call-v2\n${pathname}\n${challenge}`. Pathname is the actual socket URL path. Server challenge is single use and expires in 10 seconds. Server computes identity ID, never trusts a submitted ID.
- Server sends `{type:"authenticated", identityId}`. Subprotocol is `yorishiro-call-v2`. Names remain public labels, not authentication.
- Exact Origin allowlist for app origins and explicit local development origins; frame/message/rate/connection limits. No private keys, bearer TURN secrets, SDP, invitations, or message payloads in logs.

## Presence

Socket `/v2/users/<identityId>` uses the same challenge. Authenticated identity must match path. One live presence per identity; replacement closes the older session. Client reconnects with bounded exponential backoff. Offline delivery/waking an app is not required.

Client commands:
- `{type:"presence", name, busy:boolean}` after auth and whenever call busy state/name changes.
- `{type:"decline", roomId}` for current incoming call.
- `{type:"remove-contact", identityId}` revokes that pair's direct-call grant and removes contact metadata.

Server messages:
- `{type:"contacts", contacts:[{identityId,name,lastAcceptedAt}]}`. Max 100, bounded names, timestamps. Server is authoritative; persisted per-user DO. Only successful room admission creates a pair grant. Removal rejects future direct calls unless a new first invitation is accepted.
- `{type:"incoming", roomId, invitation, identityId, name, expiresAt}`. One pending incoming call, 45 second expiry. Names/identity come from authenticated caller. Only paired contacts may ring. No peer/media created before user Answer.
- `{type:"incoming-ended", roomId, reason}` for cancellation/expiry/disconnect.
- `{type:"error", code}` with bounded fixed codes; no raw provider failures.

## Rooms

Socket `/v2/rooms/<UUIDv4>` is per-room Durable Object. Client chooses a fresh random UUID for create; join derives room ID from invitation. Invitation format `yri2_<UUIDv4>_<22 base64url random characters>`; never a URL. Server stores token hash. WebSocket authentication above precedes existing commands. Ephemeral endpoint IDs stay UUIDv4 and are distinct from stable identities.

Client commands follow v1, with these additions:
- `{type:"create", name, targetIdentityId?:string}`. Direct call sets target. Server verifies durable grant, makes room, rings recipient or ends with offline/busy/not-contact. Invitation is target-bound. First call omits target, exposing code for manual sharing.
- `{type:"join", name, invitation}` only after user explicitly accepts incoming call (or submits first invitation).
- accept/reject/signal/ready/leave remain v1. Caller automatically accepts only a request whose broker-authenticated stable ID matches targetIdentityId.

Server room messages follow existing v1 shapes, adding `identityId` to `request`, `requested` and `admitted` (the other identity). `created` remains v1 fields; invitation is v2. Direct `created` invitation is never shown by UI. `request` carries requestId/name/endpointId plus identityId. `admitted` carries role/name/roomId/localEndpointId/remoteEndpointId/identityId/iceServers. Error codes include offline, busy, declined, no-answer, not-contact, unavailable in addition to v1.

No SDP/ICE/AI/audio before admission. On accept, both pair grants must be durably stored before admitted messages. Existing v1 room negotiation phase/order/size/rate limits apply. Room teardown notifies target inbox to clear ring. All live calls close on broker restart/loss; presence reconnects. No promise of call resume or delivery while offline.

TURN credentials are generated server-side only after admission. Managed provider credentials may have a different format from legacy coturn; validate bounded approved URLs, username, credential without applying coturn-only username/HMAC grammar to managed credentials. No cross-protocol downgrade. Require configured TURN for public deployment; local tests may explicitly run without it.
