# Direct screen vision and pointing in Codex Live

Research date: 2026-09-06. Yorishiro revision examined: `8ec170d7`.
Installed CLI: `codex-cli 0.153.4`. This was a read-only investigation; no events
were sent to an active call.

The public Realtime API supports direct image input and function calling. The
existing Codex `gpt-live-1-codex` V3 connection does not expose either capability
through its inspected app-server contract. Its WebRTC data channel makes a direct
implementation conceivable, but compatibility with public Realtime image/tool
events is unverified. A frontend-only change cannot presently be described as
supported.

## Current image and tool path

- [Screen observation](../../src/runtime/codex-realtime/screen-observation.ts)
  sends `input_text` and `input_image` through `thread/inject_items` to the main
  Codex thread. This appends history without starting a turn; acknowledgement
  does not mean the model has inspected the image. The
  [official app-server guide](https://learn.chatgpt.com/docs/app-server#inject-items-into-a-thread)
  documents this distinction.
- [The Live client](../../src/runtime/codex-realtime/codex-realtime-client.ts)
  sends only a developer-text availability notice via `thread/realtime/appendText`,
  directing visual inspection and pointing to the main agent. It selects V3,
  `gpt-live-1-codex`, audio output, and WebRTC.
- The client creates an `oai-events` data channel, but currently has no image
  sender, message listener, or function dispatcher. App disables startup context
  for its supplemental-persona connection.

## Verified capability boundaries

The installed CLI's generated experimental types expose realtime `start`,
`appendAudio`, `appendText`, `appendSpeech`, `stop`, and `listVoices` in
`ClientRequest.ts`. `ThreadRealtimeInitialItem` and
`ThreadRealtimeAppendTextParams` carry text rather than images;
`ThreadRealtimeStartParams` has no custom-tools field. `dynamicTools` and
`item/tool/call` belong to ordinary Codex turns. `McpServerToolCallParams` permits
an explicit client MCP invocation; it does not advertise a tool to the Live model.

The public Realtime documentation supports
[`conversation.item.create` with `input_image` over WebRTC or WebSocket](https://developers.openai.com/api/docs/guides/realtime-conversations#image-inputs)
and [function calling through session tools and `function_call_output`](https://developers.openai.com/api/docs/guides/realtime-conversations#function-calling).
These are public Realtime contracts, not a documented compatibility guarantee
for `gpt-live-1-codex`.

Public Codex source corroborates the distinction. At inspected upstream commit
`6af345407d9c2a568da9d01b6c4b81a9e61495c0` (not asserted to match the installed
binary), V3 maps to
[Frameless Bidi](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/core/src/realtime_conversation.rs#L1413).
Its [text append adapter](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_common.rs#L41)
emits `session.context.append`, whose
[content schema](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs#L63)
is text-only. Session configuration advertises
[client delegation](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs#L59),
and the [event parser](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs#L15)
converts `delegation.created` into a Codex handoff. A shared channel name does not
establish a shared wire protocol.

## Next implementation options

1. Keep the current supported path: main-thread image inspection and one Live
   delegation for inspection and pointing. This retains an extra model handoff.
2. Obtain the Codex Live image/custom-tool contract before extending the existing
   connection. Then add version-gated image delivery, channel readiness and
   backpressure, acknowledgements, a narrow pointer dispatcher, and correlated
   tool results. The `existingCall` transport only attaches to a client-created
   call; it does not establish image/tool compatibility.
3. A separate public Realtime integration could use its documented image and
   function support, but would require its own supported authentication, billing,
   lifecycle, and Codex handoff integration. It is not a drop-in continuation of
   the current ChatGPT-authenticated Live session and is outside this change.

Any direct path must retain active-sharing consent, document/share ownership,
pointer ON/OFF, native frame/epoch validation, normalized screenshot coordinates,
and cancellation on stop/reconnect. Report a visible mark only after tool
success. Periodic image arrival must not trigger speech or work by itself.
Validate the transport offline first; do not probe unknown events in an active call.
