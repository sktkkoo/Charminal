# Shared-display references and auxiliary controls

**Status:** experimental implementation, branched from `feat/shared-screen-companion`

The resident can point to the part of a shared display it is explaining. An
amber arrow or outline, with an optional short label, appears over the actual
desktop, including other applications. These are reference marks chosen by the
agent, not a measurement of the model's internal attention. The existing Codex
image transport and voice delegation remain the entry points; no new image
provider, login flow, or generation service is involved.

## Try it

From the `codex/shared-screen-pointers` worktree:

```sh
cd /Users/oogakitakashi/Charminal-screen-pointers
npm run tauri dev
```

1. Use the existing Codex main agent and screen-sharing button. Select a display
   and start sharing (macOS 14+, Screen Recording permission). The shared object
   is the **whole selected display**, even when Yorishiro is in Call/Portrait.
2. In the sharing settings header, click **Open screen sharing in a separate
   window** / **画面共有を別ウィンドウで開く**. This independent window can start,
   cancel, stop, select the next display, set the periodic interval, and clear marks while
   the main window remains small. Opening it does not start capture. Closing it
   leaves the existing sharing session running.
3. After an image is shared, ask through the existing conversation, for example:
   “Blender の画面で、次に調整したい部分を矢印で示して。” Starting to speak in
   GPT Live requests a fresh capture while sharing is active; an existing capture
   or delivery is reused. Live is instructed to use one delegation for the question,
   image inspection, and `screen_pointer_show`, with a grounded mark before a lengthy
   explanation. Live does not receive or claim to see the image itself. Corrections
   such as “その右隣” can replace the current mark.
4. Continue clicking, dragging, and typing in the target app while a mark is
   visible. It must not take focus or intercept input. Use **Clear screen
   markers** / **画面の目印を消す** in either set of controls, ask the agent to clear
   it, or wait for expiry (8 seconds by default; at most 15 seconds).
5. Stop sharing: the mark and all frame references are revoked. Start sharing a
   different display and confirm old frame references are rejected. Disconnecting
   or rearranging/rescaling the selected display also invalidates references;
   start sharing again before pointing.

MCP call, using the **actual** `frameId` accompanying an inspected image:

```json
{
  "frameId": "<frameId from shared-screen context>",
  "kind": "rect",
  "x": 0.25,
  "y": 0.2,
  "width": 0.18,
  "height": 0.32,
  "label": "ここを調整",
  "durationMs": 8000
}
```

Call `screen_pointer_show` with that object. An arrow uses `kind: "arrow"` and
only `x`/`y`; omit width and height. `screen_pointer_clear({})` removes the current
mark without stopping sharing. A tool success acknowledges native display, not
the correctness of the agent's interpretation. During an in-flight capture the
same tool call waits for native capture completion, then revalidates its frame,
display and sharing lease before drawing. Clear, Stop or a newer pointer request
cancels that wait immediately. Its deadline is 16 seconds (the capture timeout of
15 seconds plus a UI handoff margin); a timeout never acknowledges a shown marker.

## Coordinate and lifetime contract

- Each native capture returns an opaque frame reference and its actual JPEG
  dimensions, which travel with the image to the same main agent thread.
- `x`/`y` and rectangle dimensions are in 0–1 image coordinates with a top-left
  origin. Divide image pixel coordinates by the supplied image width/height.
  The host maps these directly to the selected display's logical point bounds;
  neither app-window CSS coordinates nor Retina backing pixels are substituted.
- Capture dimensions must match the existing full-display, maximum-2560px
  capture configuration. The host checks display geometry before and after
  capture, before showing a mark, and every 250 ms while a mark is present.
- CoreGraphics global display bounds use the main display's top-left origin.
  The native panel converts them to AppKit using
  `panelY = mainDisplayHeight - displayY - displayHeight`. Its flipped content
  view then draws local coordinates from the top-left. Negative monitor origins,
  vertical offsets and portrait displays are handled in logical points; AppKit
  renders the view at its own backing scale. CoreGraphics capture dimensions are
  not assumed to be physical Retina pixels.
  See [Apple's CGDisplayBounds contract](https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:)).
- One mark is visible at a time. Replacing or clearing it invalidates its expiry
  watchdog, so an old timer cannot erase a new mark. Stop, source/owner changes,
  main-window destruction, document reload, and shutdown revoke the lease. A
  native document epoch also rejects a begin queued before reload. A late old Stop or
  capture completion cannot affect a new lease. Voice reconnection alone does
  not change ownership.
- At most four distinct recent frame references are retained, for up to 120
  seconds after observation. Equal JPEGs with equal dimensions reuse their
  reference and refresh it, so the existing image deduplication does not strand
  the agent with an invalid token. Only fingerprints and geometry are retained
  here, not pixels. If native replaces a reference, the frontend shares it again
  even when the pixels match.
- The pointer panel is hidden during capture and its native window ID is also
  excluded from the ScreenCaptureKit filter. The still-current, unexpired mark
  is restored after capture. This prevents self-feedback in subsequent images.

## Latency investigation

The initial path contained avoidable waits before a new image could be used,
and a model retry when a pointer overlapped capture:

| Stage | Previous behavior | Current behavior |
| --- | --- | --- |
| Passive image insertion | `thread/read` then `thread/inject_items` for every image | One injection RPC; selected-owner validation and unload tracking stay in the tracker |
| Voice availability notice | Capture stayed busy until the metadata RPC acknowledged, up to its 15-second timeout | Image sharing completes at injection acknowledgement; notices are independently coalesced |
| Voice starts after sharing | Stable images were deduplicated, so a new voice connection could miss every screen notice | The current sharing lease's existing timestamp is replayed on voice connection, without recapture or image reinjection |
| User starts speaking during sharing | The next scheduled capture could be nearly one periodic interval away | Speech requests a capture immediately, joining any existing capture/delivery |
| Slow periodic capture/delivery | Missed ticks waited for the following whole interval | An overdue capture starts when the previous operation settles |
| Pointer during capture | Error requiring another model/tool round trip | The original call waits on a state-change notification, without UI-thread blocking or polling |

Deterministic tests cover one 80 ms injection round trip, a 40-second slow delivery
resuming capture at completion instead of the former 60-second tick, and image
sharing completing while voice notification remains unresolved. These are controlled
transport/scheduling tests, not measurements of authenticated voice-to-pointer latency.

The late-voice case matters for the normal App configuration, which excludes Codex
startup context when supplemental persona items are accepted. Those initial items
do not contain screen-sharing metadata. Replaying the existing availability notice
removes the wait for a changed image in that case and after a voice-only reconnect.

An isolated macOS AppKit probe measured eight samples of the same native renderer:
the cold show API took 120.316 ms and seven warm calls took 2.276–4.151 ms. A main-loop
proxy hop took 0.094–0.527 ms. These are API/CPU timings in an otherwise idle probe,
not physical display-presentation timestamps or measurements inside a loaded Yorishiro.
Screen Recording preflight was false for that probe process, so capture timing was
skipped without requesting permission or saving screen pixels.

The existing Codex V3 protocol still requires Live to delegate actual image grounding
to the main agent. The installed 0.153.4 schema exposes no verified direct realtime
image/tool path. No model or provider was changed. App connects speech-start events
from the accepted Live client to the existing sharing hook's `captureNow()`. This
only acts within an already active sharing lease, bypasses the periodic interval,
and joins an in-flight capture/delivery instead of starting concurrent work. Audio
does not wait for it. Repeated speech events are deduplicated; callbacks from an old
voice client, stopped sharing, and revoked source/thread owners cannot deliver a frame.
Unchanged images still use the existing deduplication rule.

For an explicit where/which/point request, the prompts guide Live to include the
question, image inspection, and pointer action in one delegation. The main agent
should place the grounded mark before a lengthy explanation and answer briefly.
It must inspect the actual shared attachment, rather than use `app_screenshot`,
which only captures Yorishiro's window. Missing or stale images and moved targets
require a fresh shared image before pointing. These changes remove avoidable waits;
they do not establish a guaranteed live response time or speech/mark synchronization.

The panel uses a borderless, nonactivating `NSPanel`, cannot become key/main,
ignores mouse events, and is configured to join Spaces and fullscreen auxiliary
windows. This is separate from the app-local attention/ambient/effect coordinate
system. Character gaze is intentionally left with that existing system: mapping
a desktop location to the character's camera direction would require a separate
spatial convention.

## Reusable auxiliary-window foundation

`src-tauri/src/auxiliary_windows.rs` owns allowlisted window kinds, bundled routes,
window identity checks, state publication, and action routing. The initial kind
is screen-sharing controls. Add future kinds explicitly instead of accepting
arbitrary URLs or granting web content generic window-creation authority.

The main view owns the existing sharing hook and publishes a bounded UI snapshot.
The auxiliary entry point mounts only its controls; it does not start another
App, agent, voice connection, or capture loop. Commands are checked against the
published revision and relayed back to the main owner. Snapshot updates and Stop
never focus/show the auxiliary window; only the explicit Open operation does.
The controls stay above ordinary app windows. Main-window destruction or document
reload also closes its auxiliary windows, preventing an orphaned control surface
from retaining a snapshot from the previous owner.

## Limits and validation

The feature supports the existing macOS full-display sharing route. It does not
track a moving object/window within a display: scrolling, changing a Blender
viewport, or moving an application can make a reference semantically stale even
though monitor geometry is unchanged. The agent must use recent context and ask
for an updated image when needed. Marks are short-lived; they neither click nor
edit objects. Hand-drawn image generation, edit previews, and strict speech/mark
synchronization remain separate work.

Automated coverage includes normalized/Retina/portrait coordinates, negative and
vertically offset display origins, edge labels and arrow tips, expiry/replacement,
stopped and changed leases, capture cancellation, stale native begin/stop races and reload,
deduplicated frame references, context metadata, existing voice behavior, and
auxiliary state/action boundaries. The native AppKit smoke test on the local
Retina display checked panel geometry, unchanged frontmost process, inability to
become key/main, mouse-event transparency, hide/re-show, stable window ID, and
readable Japanese labels. The actual auxiliary React view was checked at 360 ×
530 with IPC mocks, including clear/stop/source-change/restart and focus
preservation during state updates.

An authenticated end-to-end voice/Screen Recording session, an actual Tauri
auxiliary-window open/close round-trip, multiple physical monitors, and external
fullscreen/Spaces transitions still require a user trial. Pure coordinate tests
and the native panel smoke test do not establish those behaviors.
