//! Persistent capture boundary made of separate edge panels: no native window
//! covers the interior, so clicks there reach the application being shared.
use super::ScreenCaptureRegion;
use objc2::rc::Retained;
use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSBezierPath, NSColor, NSCursor, NSEvent, NSPanel, NSScreen,
    NSStatusWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
    NSWindowStyleMask,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayIsActive(display: u32) -> u32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> NSRect;
}

// Creating/replacing/destroying panels must not race ScreenCaptureKit enumeration.
static CAPTURE_EXCLUSION: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
static DOCUMENT_GENERATION: AtomicU64 = AtomicU64::new(0);
thread_local! { static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) }; }

#[derive(Clone, Copy, Debug, PartialEq)]
enum Handle {
    Move,
    North,
    West,
    East,
    South,
    NorthWest,
    NorthEast,
    SouthWest,
    SouthEast,
}
const HANDLES: [Handle; 9] = [
    Handle::North,
    Handle::West,
    Handle::East,
    Handle::South,
    Handle::NorthWest,
    Handle::NorthEast,
    Handle::SouthWest,
    Handle::SouthEast,
    // Keep the grip above the thin border panels in window order.
    Handle::Move,
];

#[derive(Clone, Copy)]
struct Drag {
    start: NSPoint,
    original: ScreenCaptureRegion,
    handle: Handle,
}
struct Session {
    app: AppHandle,
    share_id: String,
    source_id: u32,
    generation: u64,
    bounds: NSRect,
    main_height: f64,
    region: ScreenCaptureRegion,
    committed: ScreenCaptureRegion,
    panels: Vec<Retained<FramePanel>>,
    views: Vec<Retained<FrameView>>,
    previous: Option<Retained<NSWindow>>,
    drag: Option<Drag>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Adjusting {
    share_id: String,
    source_id: u32,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed {
    share_id: String,
    source_id: u32,
    region: ScreenCaptureRegion,
}

pub(super) struct CaptureGuard {
    pub excluded_windows: Vec<u32>,
    _lock: tokio::sync::RwLockReadGuard<'static, ()>,
}

async fn on_main<R: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(action());
    })
    .map_err(|_| "Could not update the capture region frame.")?;
    receiver
        .await
        .map_err(|_| "Capture region frame update cancelled.")?
}

pub(super) async fn open(
    app: &AppHandle,
    share_id: String,
    source_id: u32,
    region: ScreenCaptureRegion,
) -> Result<(), String> {
    region.validate_display(region.display_width, region.display_height)?;
    if uuid::Uuid::parse_str(&share_id).is_err() {
        return Err("Invalid region frame owner.".into());
    }
    let generation = DOCUMENT_GENERATION.load(Ordering::Acquire);
    let _lock = CAPTURE_EXCLUSION.write().await;
    let handle = app.clone();
    let watched_share_id = share_id.clone();
    on_main(app, move || {
        if generation != DOCUMENT_GENERATION.load(Ordering::Acquire) {
            return Err("The screen sharing document changed.".into());
        }
        show(handle, share_id, source_id, region, generation)
    })
    .await?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let share_id = watched_share_id.clone();
            let _lock = CAPTURE_EXCLUSION.write().await;
            let active = on_main(&app, move || {
                SESSION.with(|slot| {
                    let mut slot = slot.borrow_mut();
                    let Some(session) = slot
                        .as_ref()
                        .filter(|s| s.share_id == share_id && s.generation == generation)
                    else {
                        return Ok(false);
                    };
                    if validate_screen(session).is_ok() {
                        return Ok(true);
                    }
                    let session = slot.take().expect("session checked above");
                    hide_session(&session);
                    let _ = session.app.emit_to(
                        "main",
                        "screen-region-closed",
                        Adjusting {
                            share_id: session.share_id,
                            source_id: session.source_id,
                        },
                    );
                    Ok(false)
                })
            })
            .await;
            if !matches!(active, Ok(true)) {
                break;
            }
        }
    });
    Ok(())
}

pub(super) async fn close(app: &AppHandle, share_id: String) -> Result<(), String> {
    let _lock = CAPTURE_EXCLUSION.write().await;
    on_main(app, move || {
        SESSION.with(|slot| {
            let mut session = slot.borrow_mut();
            if session.as_ref().is_some_and(|s| s.share_id == share_id) {
                if let Some(session) = session.take() {
                    hide_session(&session);
                }
            }
        });
        Ok(())
    })
    .await
}

pub(super) async fn capture_guard(app: &AppHandle) -> Result<CaptureGuard, String> {
    let lock = CAPTURE_EXCLUSION.read().await;
    let excluded_windows = on_main(app, || {
        SESSION.with(|slot| {
            let session = slot.borrow();
            let Some(session) = session.as_ref() else {
                return Ok(Vec::new());
            };
            validate_screen(session)?;
            session
                .panels
                .iter()
                .map(|panel| {
                    u32::try_from(panel.windowNumber())
                        .ok()
                        .filter(|id| *id != 0)
                        .ok_or_else(|| {
                            "Could not identify the region frame for capture exclusion.".into()
                        })
                })
                .collect()
        })
    })
    .await?;
    Ok(CaptureGuard {
        excluded_windows,
        _lock: lock,
    })
}

pub(super) fn document_reloaded(app: &AppHandle) {
    let generation = DOCUMENT_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    // Old captures may finish after reload, but cannot publish to the new document.
    let _ = app.run_on_main_thread(move || {
        SESSION.with(|slot| {
            let mut session = slot.borrow_mut();
            if session.as_ref().is_some_and(|s| s.generation < generation) {
                if let Some(session) = session.take() {
                    hide_session(&session);
                }
            }
        })
    });
}

pub(super) fn shutdown() {
    DOCUMENT_GENERATION.fetch_add(1, Ordering::AcqRel);
    SESSION.with(|slot| {
        if let Some(session) = slot.borrow_mut().take() {
            hide_session(&session);
        }
    });
}

fn hide_session(session: &Session) {
    for panel in &session.panels {
        panel.orderOut(None);
    }
    if let Some(previous) = &session.previous {
        previous.makeKeyWindow();
    }
}
fn validate_screen(session: &Session) -> Result<(), String> {
    let bounds = unsafe { CGDisplayBounds(session.source_id) };
    let main = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    if unsafe { CGDisplayIsActive(session.source_id) } == 0
        || bounds != session.bounds
        || main.size.height != session.main_height
    {
        return Err("The shared display changed. Stop sharing and select a region again.".into());
    }
    session
        .region
        .validate_display(bounds.size.width, bounds.size.height)
}

define_class!(
    #[unsafe(super(NSPanel))]
    #[name = "YorishiroCaptureRegionFramePanel"]
    struct FramePanel;
    impl FramePanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool { true }
        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool { false }
        #[unsafe(method(constrainFrameRect:toScreen:))]
        fn constrain_frame(&self, frame: NSRect, _screen: Option<&NSScreen>) -> NSRect { frame }
    }
);
struct FrameDrawing {
    share_id: String,
    handle: Handle,
    region: Cell<NSRect>,
}
define_class!(
    #[unsafe(super(NSView))]
    #[name = "YorishiroCaptureRegionFrameView"]
    #[ivars = FrameDrawing]
    struct FrameView;
    impl FrameView {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { true }
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool { true }
        #[unsafe(method(resetCursorRects))]
        fn reset_cursor_rects(&self) {
            // macOS 14 is supported; replacement resize cursors require macOS 15.
            #[allow(deprecated)]
            let cursor = match self.ivars().handle {
                Handle::Move => NSCursor::openHandCursor(),
                Handle::West | Handle::East => NSCursor::resizeLeftRightCursor(),
                Handle::North | Handle::South => NSCursor::resizeUpDownCursor(),
                _ => NSCursor::crosshairCursor(),
            };
            self.addCursorRect_cursor(self.bounds(), &cursor);
        }
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) { begin_drag(&self.ivars().share_id, self.ivars().handle); }
        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, _event: &NSEvent) { drag(&self.ivars().share_id); }
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) { drag(&self.ivars().share_id); commit(&self.ivars().share_id, false); }
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) { if event.keyCode() == 53 { commit(&self.ivars().share_id, true); } }
        #[unsafe(method(cancelOperation:))]
        fn cancel_operation(&self, _sender: Option<&objc2::runtime::AnyObject>) { commit(&self.ivars().share_id, true); }
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            let bounds = self.bounds();
            NSColor::colorWithSRGBRed_green_blue_alpha(142.0 / 255.0, 176.0 / 255.0, 156.0 / 255.0, 1.0).setFill();
            if self.ivars().handle == Handle::Move {
                NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(bounds, 5.0, 5.0).fill();
                NSColor::whiteColor().setFill();
                for offset in [-3.0, 3.0] {
                    NSBezierPath::bezierPathWithRect(NSRect::new(
                        NSPoint::new(bounds.size.width / 2.0 - 12.0, bounds.size.height / 2.0 + offset - 1.0),
                        NSSize::new(24.0, 2.0),
                    )).fill();
                }
                return;
            }
            // A nearly invisible backing makes the full native target receive
            // mouse events; the visible boundary remains only four points wide.
            NSColor::colorWithSRGBRed_green_blue_alpha(142.0 / 255.0, 176.0 / 255.0, 156.0 / 255.0, 0.01).setFill();
            NSBezierPath::bezierPathWithRect(bounds).fill();
            NSColor::colorWithSRGBRed_green_blue_alpha(142.0 / 255.0, 176.0 / 255.0, 156.0 / 255.0, 1.0).setFill();
            let region = self.ivars().region.get();
            let corner = 10.0_f64.min(region.size.width / 3.0).min(region.size.height / 3.0);
            let edge = 4.0_f64.min(corner);
            let x = region.origin.x;
            let y = region.origin.y;
            let w = region.size.width;
            let h = region.size.height;
            // Each view clips this shared outline to its own nonoverlapping target.
            for rect in [
                NSRect::new(NSPoint::new(x, y), NSSize::new(w, edge)),
                NSRect::new(NSPoint::new(x, y + h - edge), NSSize::new(w, edge)),
                NSRect::new(NSPoint::new(x, y), NSSize::new(edge, h)),
                NSRect::new(NSPoint::new(x + w - edge, y), NSSize::new(edge, h)),
            ] { NSBezierPath::bezierPathWithRect(rect).fill(); }
            let marker = match self.ivars().handle {
                Handle::NorthWest => Some(NSPoint::new(x, y + h - corner)),
                Handle::NorthEast => Some(NSPoint::new(x + w - corner, y + h - corner)),
                Handle::SouthWest => Some(NSPoint::new(x, y)),
                Handle::SouthEast => Some(NSPoint::new(x + w - corner, y)),
                _ => None,
            };
            if let Some(origin) = marker {
                NSBezierPath::bezierPathWithRect(NSRect::new(origin, NSSize::new(corner, corner))).fill();
                NSColor::whiteColor().setFill();
                let inset = 2.0_f64.min(corner / 3.0);
                NSBezierPath::bezierPathWithRect(NSRect::new(
                    NSPoint::new(origin.x + inset, origin.y + inset),
                    NSSize::new(corner - 2.0 * inset, corner - 2.0 * inset),
                )).fill();
            }
        }
    }
);

fn begin_drag(share_id: &str, handle: Handle) {
    SESSION.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(session) = slot.as_mut().filter(|s| s.share_id == share_id) else {
            return;
        };
        if validate_screen(session).is_err() {
            return;
        }
        if let Some(mtm) = MainThreadMarker::new() {
            let previous = objc2_app_kit::NSApplication::sharedApplication(mtm).keyWindow();
            if !previous.as_ref().is_some_and(|p| {
                session
                    .panels
                    .iter()
                    .any(|s| s.windowNumber() == p.windowNumber())
            }) {
                session.previous = previous;
            }
        }
        session.drag = Some(Drag {
            start: NSEvent::mouseLocation(),
            original: session.committed,
            handle,
        });
        let _ = session.app.emit_to(
            "main",
            "screen-region-adjusting",
            Adjusting {
                share_id: session.share_id.clone(),
                source_id: session.source_id,
            },
        );
    });
}
fn drag(share_id: &str) {
    SESSION.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(session) = slot.as_mut().filter(|s| s.share_id == share_id) else {
            return;
        };
        let Some(drag) = session.drag else {
            return;
        };
        if validate_screen(session).is_err() {
            return;
        }
        let point = NSEvent::mouseLocation();
        session.region = adjusted(
            drag.original,
            drag.handle,
            point.x - drag.start.x,
            drag.start.y - point.y,
        );
        layout(session);
    });
}
fn commit(share_id: &str, cancelled: bool) {
    SESSION.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(session) = slot.as_mut().filter(|s| s.share_id == share_id) else {
            return;
        };
        let Some(drag) = session.drag.take() else {
            return;
        };
        if cancelled {
            session.region = drag.original;
            layout(session);
        }
        session.committed = session.region;
        if let Some(previous) = session.previous.take() {
            previous.makeKeyWindow();
        }
        let _ = session.app.emit_to(
            "main",
            "screen-region-changed",
            Changed {
                share_id: session.share_id.clone(),
                source_id: session.source_id,
                region: session.committed,
            },
        );
    });
}

fn adjusted(
    original: ScreenCaptureRegion,
    handle: Handle,
    dx: f64,
    dy: f64,
) -> ScreenCaptureRegion {
    let mut region = original;
    if !dx.is_finite() || !dy.is_finite() {
        return region;
    }
    if handle == Handle::Move {
        region.x = (original.x + dx.round()).clamp(0.0, original.display_width - original.width);
        region.y = (original.y + dy.round()).clamp(0.0, original.display_height - original.height);
    } else {
        let min_width = 16.0_f64.min(original.width);
        let min_height = 16.0_f64.min(original.height);
        let right = original.x + original.width;
        let bottom = original.y + original.height;
        if matches!(handle, Handle::West | Handle::NorthWest | Handle::SouthWest) {
            region.x = (original.x + dx.round()).clamp(0.0, right - min_width);
            region.width = right - region.x;
        }
        if matches!(handle, Handle::East | Handle::NorthEast | Handle::SouthEast) {
            region.width =
                (original.width + dx.round()).clamp(min_width, original.display_width - original.x);
        }
        if matches!(
            handle,
            Handle::North | Handle::NorthWest | Handle::NorthEast
        ) {
            region.y = (original.y + dy.round()).clamp(0.0, bottom - min_height);
            region.height = bottom - region.y;
        }
        if matches!(
            handle,
            Handle::South | Handle::SouthWest | Handle::SouthEast
        ) {
            region.height = (original.height + dy.round())
                .clamp(min_height, original.display_height - original.y);
        }
    }
    region
}

/// The grip normally sits above the boundary. Clamp it on-screen; if that would
/// cover a tiny selection or a resize corner, place it outside another edge.
fn move_grip_rect(region: ScreenCaptureRegion) -> NSRect {
    let width = 72.0_f64.min(region.display_width);
    let height = 24.0_f64.min(region.display_height);
    let x = (region.x + (region.width - width) / 2.0).clamp(0.0, region.display_width - width);
    let gap = 10.0;
    let top = (region.y - gap - height).max(0.0);
    // On a normal-sized selection the clamped grip occupies only its top
    // perimeter, between the corners. The rest of the interior is click-through.
    if region.y >= height + gap || (region.width >= width + 48.0 && region.height >= height * 2.0) {
        return NSRect::new(NSPoint::new(x, top), NSSize::new(width, height));
    }
    if region.y + region.height + gap + height <= region.display_height {
        return NSRect::new(
            NSPoint::new(x, region.y + region.height + gap),
            NSSize::new(width, height),
        );
    }
    let y = (region.y + (region.height - height) / 2.0).clamp(0.0, region.display_height - height);
    if region.x + region.width + gap + width <= region.display_width {
        return NSRect::new(
            NSPoint::new(region.x + region.width + gap, y),
            NSSize::new(width, height),
        );
    }
    if region.x >= width + gap {
        return NSRect::new(
            NSPoint::new(region.x - width - gap, y),
            NSSize::new(width, height),
        );
    }
    // Only relevant to displays smaller than the normal grip clearance.
    NSRect::new(NSPoint::new(x, top), NSSize::new(width, height))
}

/// Border panels cover the perimeter; the separate grip leaves the center clear.
fn handle_rect(region: ScreenCaptureRegion, handle: Handle) -> NSRect {
    if handle == Handle::Move {
        return move_grip_rect(region);
    }
    let x = region.x;
    let y = region.y;
    let right = x + region.width;
    let bottom = y + region.height;
    let left_out = (x - 10.0).max(0.0);
    let top_out = (y - 10.0).max(0.0);
    let right_out = (right + 10.0).min(region.display_width);
    let bottom_out = (bottom + 10.0).min(region.display_height);
    // Normally 24 pt corners and 16 pt edges, mostly outside the selection.
    // At screen edges move the target inward; for tiny selections limit that
    // inward part to a third so the center and neighboring handles stay clear.
    let left_corner = x + (24.0 - (x - left_out)).min(region.width / 3.0);
    let right_corner = right - (24.0 - (right_out - right)).min(region.width / 3.0);
    let top_corner = y + (24.0 - (y - top_out)).min(region.height / 3.0);
    let bottom_corner = bottom - (24.0 - (bottom_out - bottom)).min(region.height / 3.0);
    let left_edge = x + (16.0 - (x - left_out)).min(region.width / 3.0);
    let right_edge = right - (16.0 - (right_out - right)).min(region.width / 3.0);
    let top_edge = y + (16.0 - (y - top_out)).min(region.height / 3.0);
    let bottom_edge = bottom - (16.0 - (bottom_out - bottom)).min(region.height / 3.0);
    let (left, top, right, bottom) = match handle {
        Handle::Move => unreachable!(),
        Handle::North => (left_corner, top_out, right_corner, top_edge),
        Handle::South => (left_corner, bottom_edge, right_corner, bottom_out),
        Handle::West => (left_out, top_corner, left_edge, bottom_corner),
        Handle::East => (right_edge, top_corner, right_out, bottom_corner),
        Handle::NorthWest => (left_out, top_out, left_corner, top_corner),
        Handle::NorthEast => (right_corner, top_out, right_out, top_corner),
        Handle::SouthWest => (left_out, bottom_corner, left_corner, bottom_out),
        Handle::SouthEast => (right_corner, bottom_corner, right_out, bottom_out),
    };
    NSRect::new(
        NSPoint::new(left, top),
        NSSize::new(right - left, bottom - top),
    )
}

fn layout(session: &Session) {
    for ((panel, view), handle) in session.panels.iter().zip(&session.views).zip(HANDLES) {
        let rect = handle_rect(session.region, handle);
        let global = NSRect::new(
            NSPoint::new(
                session.bounds.origin.x + rect.origin.x,
                session.main_height - session.bounds.origin.y - rect.origin.y - rect.size.height,
            ),
            rect.size,
        );
        // NSView uses bottom-left coordinates while capture regions use top-left.
        view.ivars().region.set(NSRect::new(
            NSPoint::new(
                session.region.x - rect.origin.x,
                rect.origin.y + rect.size.height - session.region.y - session.region.height,
            ),
            NSSize::new(session.region.width, session.region.height),
        ));
        panel.setFrame_display(global, true);
        view.setNeedsDisplay(true);
    }
}

fn show(
    app: AppHandle,
    share_id: String,
    source_id: u32,
    region: ScreenCaptureRegion,
    generation: u64,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Capture region frame requires the main thread.")?;
    let bounds = unsafe { CGDisplayBounds(source_id) };
    if unsafe { CGDisplayIsActive(source_id) } == 0 {
        return Err("The selected display is no longer available.".into());
    }
    region.validate_display(bounds.size.width, bounds.size.height)?;
    if SESSION.with(|slot| slot.borrow().is_some()) {
        return Err("A capture region frame is already open.".into());
    }
    let mut session = Session {
        app,
        share_id: share_id.clone(),
        source_id,
        generation,
        bounds,
        main_height: unsafe { CGDisplayBounds(CGMainDisplayID()) }.size.height,
        region,
        committed: region,
        panels: Vec::new(),
        views: Vec::new(),
        previous: None,
        drag: None,
    };
    for handle in HANDLES {
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 10.0));
        let panel: Retained<FramePanel> = unsafe {
            msg_send![FramePanel::alloc(mtm),initWithContentRect:frame,styleMask:NSWindowStyleMask::Borderless,backing:NSBackingStoreType::Buffered,defer:false]
        };
        unsafe { panel.setReleasedWhenClosed(false) };
        panel.setMovable(false);
        panel.setOpaque(false);
        panel.setBackgroundColor(Some(&NSColor::clearColor()));
        panel.setHasShadow(false);
        panel.setLevel(NSStatusWindowLevel + 1);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        panel.setSharingType(NSWindowSharingType::None);
        let view = FrameView::alloc(mtm).set_ivars(FrameDrawing {
            share_id: share_id.clone(),
            handle,
            region: Cell::new(frame),
        });
        let view: Retained<FrameView> = unsafe { msg_send![super(view),initWithFrame:frame] };
        panel.setContentView(Some(&view));
        panel.makeFirstResponder(Some(&view));
        session.panels.push(panel);
        session.views.push(view);
    }
    layout(&session);
    for panel in &session.panels {
        panel.orderFrontRegardless();
    }
    SESSION.with(|slot| *slot.borrow_mut() = Some(session));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original() -> ScreenCaptureRegion {
        ScreenCaptureRegion {
            x: 100.0,
            y: 80.0,
            width: 400.0,
            height: 240.0,
            display_width: 1440.0,
            display_height: 900.0,
        }
    }
    #[test]
    fn move_and_resize_stay_inside_the_explicit_display() {
        for handle in HANDLES {
            for (dx, dy) in [
                (-5000.0, -5000.0),
                (5000.0, 5000.0),
                (-300.0, 400.0),
                (5.5, -9.1),
            ] {
                let region = adjusted(original(), handle, dx, dy);
                assert!(region.validate_display(1440.0, 900.0).is_ok());
                if handle == Handle::Move {
                    assert_eq!((region.width, region.height), (400.0, 240.0));
                }
            }
        }
        assert_eq!(
            adjusted(original(), Handle::Move, f64::NAN, 0.0),
            original()
        );
    }
    #[test]
    fn no_panel_covers_the_region_interior() {
        let region = original();
        for handle in HANDLES {
            let rect = handle_rect(region, handle);
            let center = NSPoint::new(
                region.x + region.width / 2.0,
                region.y + region.height / 2.0,
            );
            assert!(
                !(rect.origin.x <= center.x
                    && center.x <= rect.origin.x + rect.size.width
                    && rect.origin.y <= center.y
                    && center.y <= rect.origin.y + rect.size.height)
            );
            assert!(rect.origin.x >= 0.0 && rect.origin.y >= 0.0);
            assert!(rect.origin.x + rect.size.width <= region.display_width);
            assert!(rect.origin.y + rect.size.height <= region.display_height);
        }
    }
    #[test]
    fn move_grip_is_large_visible_and_clear_of_corners_and_center_at_display_edges() {
        for (width, height) in [
            (400.0, 240.0),
            (2.0, 2.0),
            (16.0, 900.0),
            (1440.0, 16.0),
            (1440.0, 900.0),
        ] {
            for x in [0.0, (1440.0 - width) / 2.0, 1440.0 - width] {
                for y in [0.0, 12.0_f64.min(900.0 - height), 900.0 - height] {
                    let region = ScreenCaptureRegion {
                        x,
                        y,
                        width,
                        height,
                        ..original()
                    };
                    let grip = handle_rect(region, Handle::Move);
                    assert_eq!(grip.size, NSSize::new(72.0, 24.0));
                    assert!(grip.origin.x >= 0.0 && grip.origin.y >= 0.0);
                    assert!(grip.origin.x + grip.size.width <= region.display_width);
                    assert!(grip.origin.y + grip.size.height <= region.display_height);
                    let center = NSPoint::new(x + width / 2.0, y + height / 2.0);
                    assert!(
                        !(grip.origin.x <= center.x
                            && center.x < grip.origin.x + grip.size.width
                            && grip.origin.y <= center.y
                            && center.y < grip.origin.y + grip.size.height)
                    );
                    for handle in [
                        Handle::NorthWest,
                        Handle::NorthEast,
                        Handle::SouthWest,
                        Handle::SouthEast,
                    ] {
                        let corner = handle_rect(region, handle);
                        assert!(
                            !(grip.origin.x < corner.origin.x + corner.size.width
                                && corner.origin.x < grip.origin.x + grip.size.width
                                && grip.origin.y < corner.origin.y + corner.size.height
                                && corner.origin.y < grip.origin.y + grip.size.height)
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn resize_targets_are_larger_than_the_painted_border_even_at_screen_edges() {
        for (x, y) in [(100.0, 80.0), (0.0, 0.0), (1040.0, 660.0)] {
            let region = ScreenCaptureRegion { x, y, ..original() };
            for handle in [Handle::North, Handle::South] {
                assert_eq!(handle_rect(region, handle).size.height, 16.0);
            }
            for handle in [Handle::West, Handle::East] {
                assert_eq!(handle_rect(region, handle).size.width, 16.0);
            }
            for handle in [
                Handle::NorthWest,
                Handle::NorthEast,
                Handle::SouthWest,
                Handle::SouthEast,
            ] {
                assert_eq!(handle_rect(region, handle).size, NSSize::new(24.0, 24.0));
            }
        }
    }
    #[test]
    fn resize_targets_do_not_overlap_or_cover_center_including_tiny_selections() {
        for (width, height) in [
            (400.0, 240.0),
            (2.0, 2.0),
            (16.0, 900.0),
            (1440.0, 16.0),
            (1440.0, 900.0),
        ] {
            for x in [0.0, (1440.0 - width) / 2.0, 1440.0 - width] {
                for y in [0.0, (900.0 - height) / 2.0, 900.0 - height] {
                    let region = ScreenCaptureRegion {
                        x,
                        y,
                        width,
                        height,
                        ..original()
                    };
                    let targets: Vec<_> = HANDLES
                        .into_iter()
                        .filter(|h| *h != Handle::Move)
                        .map(|h| handle_rect(region, h))
                        .collect();
                    for (i, a) in targets.iter().enumerate() {
                        assert!(a.size.width > 0.0 && a.size.height > 0.0);
                        assert!(a.origin.x >= 0.0 && a.origin.y >= 0.0);
                        assert!(a.origin.x + a.size.width <= region.display_width);
                        assert!(a.origin.y + a.size.height <= region.display_height);
                        assert!(
                            !(a.origin.x <= x + width / 2.0
                                && x + width / 2.0 < a.origin.x + a.size.width
                                && a.origin.y <= y + height / 2.0
                                && y + height / 2.0 < a.origin.y + a.size.height)
                        );
                        for b in &targets[i + 1..] {
                            assert!(
                                !(a.origin.x < b.origin.x + b.size.width
                                    && b.origin.x < a.origin.x + a.size.width
                                    && a.origin.y < b.origin.y + b.size.height
                                    && b.origin.y < a.origin.y + a.size.height)
                            );
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn top_edge_resizes_while_grip_only_translates() {
        let region = original();
        let resized = adjusted(region, Handle::North, 25.0, 30.0);
        assert_eq!((resized.x, resized.width), (region.x, region.width));
        assert_eq!((resized.y, resized.height), (110.0, 210.0));
        let moved = adjusted(region, Handle::Move, 25.0, 30.0);
        assert_eq!((moved.x, moved.y), (125.0, 110.0));
        assert_eq!((moved.width, moved.height), (region.width, region.height));
    }
    #[test]
    fn resizing_never_flips_or_expands_a_tiny_selection_by_default() {
        let region = ScreenCaptureRegion {
            width: 2.0,
            height: 2.0,
            ..original()
        };
        for handle in HANDLES {
            assert_eq!(adjusted(region, handle, 0.0, 0.0), region);
        }
    }
}
