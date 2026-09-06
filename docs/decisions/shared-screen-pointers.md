# Shared-display references and auxiliary controls

**Status:** experimental implementation, branched from `feat/shared-screen-companion`

The resident can point to the part of a shared display it is explaining. An
arrow, rectangle, or ellipse, with an optional short note, appears over the actual
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
2. The sharing button chooses the controls' destination when clicked. Call and
   Portrait always open a separate window. Terminal, Theater, and Immersive use
   an inline panel when its full content fits, otherwise a separate window.
   Resizing an open panel does not move it to another window. The separate controls
   can start, cancel, stop, select the next display, and set the periodic interval
   while the main window remains small. Opening controls does not start
   capture, and closing them leaves the existing sharing session running. If the
   separate window fails to open, use the compact retry card or the sharing button
   again; Close dismisses the error.
3. After an image is shared, ask through the existing conversation, for example:
   “Blender の画面で、次にどこを調整するとよさそう？” While sharing and markers
   are ON, the agent should proactively mark a clearly identified target when it
   helps explain the screen discussion; no separate request to point is needed.
   Unrelated conversation, uncertain targets, and explanations that gain no clarity
   from a mark should remain unmarked. Starting to speak in
   GPT Live requests a fresh capture while sharing is active; an existing capture
   or delivery is reused. Live is instructed to use one delegation for the question,
   image inspection, and `screen_pointer_show`, with a grounded mark before a lengthy
   explanation. Live does not receive or claim to see the image itself. Corrections
   such as “その右隣” can replace the current mark.
4. Use **Agent pointing** / **エージェントの指し示し** in either set of controls to turn marks
   off independently of sharing. OFF immediately clears marks and waiting requests;
   images continue to reach the same agent. The preference defaults to ON and is
   saved as `screenPointersEnabled` in the existing user config. Turning it back on
   permits new marks only from a subsequent capture, without restoring old marks.
5. Continue clicking, dragging, and typing in the target app while a mark is
   visible. It must not take focus or intercept input. Ask the agent to clear
   it, or wait for expiry (8 seconds by default; at most 15 seconds). The controls
   omit a manual clear button; Agent pointing OFF and Stop sharing still clear marks.
6. Stop sharing: the mark and all frame references are revoked. Start sharing a
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

Call `screen_pointer_show` with that object. Use `kind: "ellipse"` with the same
bounding-box fields for an ellipse or circle. Width and height refer to their
respective image axes; equal normalized dimensions produce a circle only for a
square image. An arrow uses `kind: "arrow"` and only `x`/`y`; omit width and height.
`screen_pointer_clear({})` removes the current
mark without stopping sharing. A tool success acknowledges native display, not
the correctness of the agent's interpretation. During an in-flight capture the
same tool call waits for native capture completion, then revalidates its frame,
display and sharing lease before drawing. OFF, Clear, Stop or a newer pointer request
cancels that wait immediately. Its deadline is 16 seconds (the capture timeout of
15 seconds plus a UI handoff margin); a timeout never acknowledges a shown marker.

## Coordinate and lifetime contract

- Each native capture returns an opaque frame reference and its actual JPEG
  dimensions, which travel with the image to the same main agent thread.
- `x`/`y` and rectangle/ellipse dimensions are in 0–1 image coordinates with a top-left
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
  renders the view at its own backing scale. Capture dimensions use the current
  display mode's backing pixels, while marker positions remain in logical points.
  See [Apple's CGDisplayBounds contract](https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:)).
- One mark is visible at a time. Replacing or clearing it invalidates its expiry
  watchdog, so an old timer cannot erase a new mark. Stop, source/owner changes,
  main-window destruction, document reload, and shutdown revoke the lease. A
  native document epoch also rejects a begin queued before reload. A late old Stop or
  capture completion cannot affect a new lease. Voice reconnection alone does
  not change ownership.
- At most 128 distinct recent frame references are retained, for up to 120
  seconds after observation. Equal JPEGs with equal dimensions reuse their
  reference and refresh it, so the existing image deduplication does not strand
  the agent with an invalid token. Only fingerprints and geometry are retained
  here, not pixels. If native replaces a reference, the frontend shares it again
  even when the pixels match.
- A show request accepted before capture finishes retains its original reference
  and observation time through capacity eviction. It still checks that image's
  age, document, sharing lease, pointer setting, generation, and display geometry
  before drawing. Only re-observation of the exact same cached image ID can refresh
  its age; a different newer image never lends its timestamp or coordinates.
- The pointer panel is hidden during capture and its native window ID is also
  excluded from the ScreenCaptureKit filter. The still-current, unexpired mark
  is restored after capture. This prevents self-feedback in subsequent images.

## Independent marker preference

The main window applies the persisted preference before sharing can start. Both
controls use that single owner and native document epoch; an auxiliary view cannot
grant pointer authority directly. Settings have monotonically increasing request
revisions, so an old ON cannot undo a later OFF. A newer update that skips an
intermediate revision also revokes marks when the final boolean is unchanged.
Reload preserves the native preference while replacing document authority.

Both toggle edges revoke pending requests and all old frame references, including
fingerprint reuse. Capture keeps its sharing lease. If a capture began before a
toggle and finishes afterward, its image still reaches the agent, but its reference
cannot authorize a mark. The native response includes `pointersEnabled` and
`pointerFrameValid`; a new capture after ON provides a usable reference even when
its pixels are unchanged. OFF errors explicitly instruct the agent to stop pointer
calls and retries until the user enables them.

Changing the preference also sends a text-only update to the validated main thread
and updates Live's metadata. It neither starts a new turn nor requests another
capture. The latest explicit preference takes precedence over delayed image
metadata, and voice reconnects replay the current state. Audio, image delivery and
native OFF do not wait for metadata acknowledgement or queued config writes.

## Native handwriting and readability

All three shapes share a restrained pencil treatment: a 1.7-point pale sage
stroke over a 2.8-point dark edge. The arrow follows a shallow cubic curve with
an exact target tip. Rectangle corners and ellipse extrema preserve the supplied
bounding box; small, fixed inward bows and asymmetric tangents provide the drawn
character. Repeated draws produce the same path, with no random jitter or drawing
animation.

Notes have no background plate or enclosing border. Klee One SemiBold at 18 points
provides Japanese handwriting. Each note draws its dark glyph outline and soft
shadow first, then its light face, keeping the outline from covering fine pen
strokes. Labels sit beside the arrow tail or outside a shape where space allows;
long text remains on one line and truncates within the display bounds.

The fixed light/dark treatment works without classifying the background or taking
another capture. It is the same palette over light, dark and mixed content. The
font is embedded from the pinned, unmodified Fontworks release and created directly
from data by CoreText on first use, then cached on the main thread. It is never
installed into the system. A local Japanese font and the system font provide
fallbacks. The 8.49 MiB font and its app-bundled OFL notice are documented in
[the font provenance record](../../src-tauri/assets/fonts/README.md).

These previews use the actual native renderer and font over synthetic backgrounds;
they are not the earlier image-generation concept or screenshots of private apps:

- [Dark workspace](../assets/screen-pointers-dark.png)
- [Light workspace](../assets/screen-pointers-light.png)
- [Mixed, textured background](../assets/screen-pointers-mixed.png)

Regenerate them on macOS after building Rust dependencies:

```sh
python3 scripts/render-screen-pointers.py
```

The harness creates hidden native views without taking a desktop screenshot,
requesting Screen Recording permission, or activating a window.

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

The final handwriting renderer was measured separately with a Tao/AppKit probe:
one cold show took 41.342 ms; 21 warm shows across all three shapes took
0.661–1.187 ms (median 0.954 ms). Warm forced-paint calls took 0.083–0.145 ms,
and main-queue dispatch took 0.025–0.058 ms. The probe asserted unchanged focus,
non-key/non-main behavior, mouse transparency, stable window identity and content
release on hide, with zero captures. These are API/CPU measurements, not physical
presentation or authenticated voice-to-pointer latency, and are not a controlled
before/after comparison with the earlier probe. See the
[complete numeric record](../assets/screen-pointers-latency.txt).

The current app delegates Live's image inspection to the main agent. The installed
0.153.4 schema exposes no verified direct realtime image/tool path, and the existing
WebRTC data channel's compatibility with public Realtime image/tool events remains
unverified. See the [direct Live investigation](codex-live-image-input.md).
No model or provider was changed. App connects speech-start events
from the accepted Live client to the existing sharing hook's `captureNow()`. This
only acts within an already active sharing lease, bypasses the periodic interval,
and joins an in-flight capture/delivery instead of starting concurrent work. Audio
does not wait for it. Repeated speech events are deduplicated; callbacks from an old
voice client, stopped sharing, and revoked source/thread owners cannot deliver a frame.
Unchanged images still use the existing deduplication rule.

While sharing and markers are ON, the prompts guide Live to include the
conversational question, image inspection, and a useful pointer action in one
delegation. The main agent should proactively mark a clearly identified target
when it helps explain the current screen discussion, without requiring a separate
request to point. It should place the grounded mark before a lengthy explanation
and answer briefly. Unrelated conversation, uncertain targets, and marks that add
no clarity are excluded. Neither a capture nor an ON notification starts work
by itself. OFF and invalid-frame guidance takes precedence over marker use.
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

Pointer settings use a separate revision that changes only with the owning main
session/thread, pointer preference, or pointer readiness. Both native acceptance
and main-window application validate it. A capture completion between those two
steps therefore cannot silently discard an OFF action, while an old owner or
superseded pointer preference remains fenced out. Other auxiliary actions retain
the existing complete-snapshot revision check.

## Limits and validation

The feature supports the existing macOS full-display sharing route. It does not
track a moving object/window within a display: scrolling, changing a Blender
viewport, or moving an application can make a reference semantically stale even
though monitor geometry is unchanged. The agent must use recent context and ask
for an updated image when needed. Marks are short-lived; they neither click nor
edit objects. AI-generated edit previews and strict speech/mark
synchronization remain separate work.

Automated coverage includes normalized/Retina/portrait coordinates, negative and
vertically offset display origins, edge labels and arrow tips, expiry/replacement,
stopped and changed leases, capture cancellation, stale native begin/stop races and reload,
deduplicated frame references, context metadata, existing voice behavior, and
auxiliary state/action boundaries. The native AppKit smoke test on the local
Retina display checked panel geometry, unchanged frontmost process, inability to
become key/main, mouse-event transparency, hide/re-show, stable window ID, and
readable Japanese labels. The actual auxiliary React view was checked at 360 ×
530 with IPC mocks, including stop/source-change/restart and focus
preservation during state updates.

An authenticated end-to-end voice/Screen Recording session, an actual Tauri
auxiliary-window open/close round-trip, multiple physical monitors, and external
fullscreen/Spaces transitions still require a user trial. Pure coordinate tests
and the native panel smoke test do not establish those behaviors.

At the initial implementation checkpoint, all 427 Rust tests (409 library and 18 CLI), the related frontend
tests, strict all-target/all-feature Clippy, formatting and the frontend production
build passed. The local debug macOS `.app` also built successfully, and its readable
OFL resource was checked against the source license. This build was not installed,
launched as an authenticated user session, signed for distribution, or published.

### Startup and controls follow-up

A user trial of the development build initially found display selection, agent
pointing, and Start sharing all disabled. The pointer preference was held in App
state but populated only by a setter captured inside the HMR-persistent runtime
bootstrap. Recreating App could leave the new state permanently unresolved.
The settings hook now loads configuration itself after mounting, independently of
that bootstrap. Preference intent, accepted state, and native request revisions
survive component and module replacement. A pending OFF remains OFF across a
remount, and old native replies cannot restore the opposite setting. Configuration
read-modify-writes share a document-lifetime queue so an older App's delayed save
cannot overwrite a newer choice or another configuration update.

The user subsequently confirmed that display selection, the agent-pointing
toggle, and Start sharing all work in the development build. This confirms those
controls, not the complete voice-to-pointing path. Regression tests cover initial
reads, StrictMode, component/module replacement, delayed native replies in either
order, delayed persistence, and failed reads/writes.

The main and auxiliary controls use concise matching labels and retain only the
one-line token-usage notice, with a small Experimental label beside the heading.
The first pop-out implementation closed the original sharing popover after success
and retained its controls on failure. It is now
superseded by automatic destination selection, described below. Repeated clicks
share one pending open request; opening controls does not close the main application
window or stop sharing.

For this follow-up, 288 related frontend/configuration/UI tests and the native
MCP-instructions test passed, along with TypeScript, Biome, Rust formatting, and
the frontend production build. The existing large-bundle warning remains.

### Frequent-capture reference eviction

Local native results from the reported failure returned `no longer available`
for images only about 15–17 seconds old at tool-call submission. The calls completed
roughly 3–7 seconds later. This was capacity eviction, not the 120-second age
limit: four distinct references at a five-second interval could lose the first
image in about 20 seconds. A capture finishing while an accepted pointer was waiting
could also remove its reference. Cursor motion alone can change the JPEG fingerprint.

The reference history now holds up to 128 metadata records within the same
120-second freshness limit, and an accepted show retains the exact inspected
reference during its bounded capture wait. Images are not retained by this cache,
old IDs are never replaced by the latest ID, and expired or revoked authority stays
invalid. Regression cases cover the old 20-second failure, five-second updates
plus speech-capture bursts, eviction while waiting, age renewal only for the same
image, and cancellation after OFF, clear, Stop, document or display changes.

Periodic capture is separately limited to 20–60 seconds, with the existing
30-second default. Main and auxiliary sliders, both action validators, and the
actual timer use that range; a retained pre-update five-second value is normalized.
Speech-triggered capture still joins an in-flight request or captures immediately.
The interval change reduces avoidable updates but does not replace reference
retention, because speech captures can occur between periodic updates.

The native regressions passed after first reproducing both capacity failures on
the old implementation. All 31 annotation tests, seven auxiliary-window tests,
strict all-target/all-feature Clippy, and Rust formatting passed. The accepted
reference also keeps its latest same-ID observation when renewal is followed by
capacity eviction; it cannot fall back to an older timestamp or borrow a newly
issued ID for identical pixels. An independent review found no remaining issue
with reference identity or the existing revocation boundaries.

### Automatic sharing-controls destination

Call and Portrait now open the auxiliary controls directly from the sharing
button; there is no manual pop-out button. Their pack IDs are `portrait` and
`companion`, respectively. Other modes measure the real inline content once when
the user clicks or presses Arrow Down. The hidden, inert measurement has no
height constraint or focus effect. The panel appears inline only when its full
width and height fit within the available viewport. Opening controls refreshes
idle display choices but never starts sharing. Later resize events only reposition
the existing panel; another click decides the next destination.

A failed auxiliary open shows a compact error card with Retry and Close rather
than the full sharing form. It sits below the title bar with the error text
scrollable independently of its controls. In modes with hidden window chrome,
the title bar is raised above the voice layer only while this card is visible.
This keeps Retry accessible even with long errors in a 200 × 300 Call window.
The sharing button itself can also retry. Explicit opens can recover failed
snapshot publication or action-listener registration without changing ownership,
duplicating subscriptions, or starting a capture. A successful retry clears the
transient error.

At this checkpoint, 47 related UI/bridge tests and TypeScript passed, along with
the production frontend build. A browser fixture using the real title bar,
controls, and voice-layer CSS verified destination selection, click-time resize
decisions, and both retry paths in a 200 × 300 viewport. Auxiliary IPC was mocked;
this does not verify the actual native window load. A user trial initially reported
a black auxiliary window, then controls appearing after a long wait alongside
broader UI slowdown. Its cause was not established; loading in a real session
still needs verification.

One known integration follow-up remains: App's capture-phase Escape shortcut can
stop voice or exit a view mode before an open sharing dialog receives Escape.
The dialog's Close button works; the global shortcut must yield to the open dialog
before Escape can be advertised as its dismissal action.

The final controls cleanup removed the manual clear button from both views and
added the Experimental label. Pointer OFF, Stop sharing, automatic expiry, the
native clear command, and the agent's `screen_pointer_clear` tool remain available.
All 27 existing inline and auxiliary UI tests passed after that cleanup.

### Retina capture detail

A read-only display diagnostic found a 1470 × 956 logical desktop whose current
mode has 2940 × 1912 backing pixels. `CGDisplayPixelsWide/High` returned the logical
1470 × 956 size on this display. Three earlier delivered JPEGs were inspected only
for their SOF dimension headers: their actual size was 1470 × 956, matching their
frame metadata. The capture configuration had therefore requested less detail
than the display's backing image could supply. JPEG encoding and the existing
`inject_items` path do not apply a second resize.

Capture and pointer validation now share `CGDisplayModeGetPixelWidth/Height`
dimensions. Current desktop bounds determine their orientation so a rotated mode
is neither stretched nor rotated twice. A mismatched or unavailable mode is
excluded from the source list and cannot be captured; another unavailable display
does not block the selected one. Normalized marker positions continue to map to
the same logical desktop bounds, and the existing display-change gates remain.

The 2560-pixel longest-edge limit, JPEG quality, byte limit, and transport are
unchanged. For the measured mode, the expected output is 2560 × 1664, calculated
from 2940 × 1912 backing pixels. This is downsampling the real backing image,
not enlarging an existing 1470 × 956 JPEG. No capture was taken after this change,
so the new JPEG dimensions still need verification in the rebuilt development app.

The five dimension tests passed in a lightweight standalone harness using the
current production functions and their test module. Single-job `cargo check
--offline --lib`, Rust formatting, and diff checks also passed. No full app build,
new capture, or application restart was performed for this change.
