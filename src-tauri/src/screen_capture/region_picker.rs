//! A native, pixel-free drag selector. Only the chosen logical rectangle leaves AppKit.
use super::{ScreenCaptureRegion, ScreenCaptureRegionSelection};
use objc2::rc::Retained;
use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSBezierPath, NSColor, NSCursor, NSEvent, NSPanel, NSScreen,
    NSStatusWindowLevel, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowSharingType,
    NSWindowStyleMask,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;
use tokio::sync::oneshot;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayIsActive(display: u32) -> u32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> NSRect;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
}

type Reply = oneshot::Sender<Result<Option<ScreenCaptureRegionSelection>, String>>;
struct Session {
    panels: Vec<Retained<PickerPanel>>,
    previous: Option<Retained<NSWindow>>,
    sender: Option<Reply>,
    token: String,
    generation: u64,
}
static DOCUMENT_GENERATION: AtomicU64 = AtomicU64::new(0);
thread_local! { static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) }; }

define_class!(
    #[unsafe(super(NSPanel))]
    #[name = "YorishiroScreenRegionPanel"]
    struct PickerPanel;
    impl PickerPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool { true }
        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool { false }
        #[unsafe(method(constrainFrameRect:toScreen:))]
        fn constrain_frame(&self, frame: NSRect, _screen: Option<&NSScreen>) -> NSRect { frame }
    }
);

struct SelectionDrawing {
    start: RefCell<Option<NSPoint>>,
    end: RefCell<Option<NSPoint>>,
    size: NSSize,
    source_id: u32,
    token: String,
}

define_class!(
    #[unsafe(super(NSView))]
    #[name = "YorishiroScreenRegionView"]
    #[ivars = SelectionDrawing]
    struct PickerView;
    impl PickerView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool { true }
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { true }
        #[unsafe(method(resetCursorRects))]
        fn reset_cursor_rects(&self) {
            self.addCursorRect_cursor(self.bounds(), &NSCursor::crosshairCursor());
        }
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let point = self.point(event);
            *self.ivars().start.borrow_mut() = Some(point);
            *self.ivars().end.borrow_mut() = Some(point);
            self.setNeedsDisplay(true);
        }
        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            *self.ivars().end.borrow_mut() = Some(self.point(event));
            self.setNeedsDisplay(true);
        }
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, event: &NSEvent) {
            *self.ivars().end.borrow_mut() = Some(self.point(event));
            let region = self.region().filter(|r| r.width >= 2.0 && r.height >= 2.0);
            if let Some(region) = region {
                finish(&self.ivars().token, Ok(Some(ScreenCaptureRegionSelection { source_id:self.ivars().source_id,region })));
            }
        }
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) {
            if event.keyCode() == 53 { finish(&self.ivars().token, Ok(None)); }
        }
        #[unsafe(method(cancelOperation:))]
        fn cancel_operation(&self, _sender: Option<&objc2::runtime::AnyObject>) {
            finish(&self.ivars().token, Ok(None));
        }
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            NSColor::colorWithSRGBRed_green_blue_alpha(0.0,0.0,0.0,0.28).setFill();
            NSBezierPath::bezierPathWithRect(self.bounds()).fill();
            if let Some(region) = self.region() {
                let rect = NSRect::new(NSPoint::new(region.x,region.y),NSSize::new(region.width,region.height));
                NSColor::colorWithSRGBRed_green_blue_alpha(1.0,1.0,1.0,0.13).setFill();
                let path = NSBezierPath::bezierPathWithRect(rect);
                path.fill();
                NSColor::whiteColor().setStroke();
                path.setLineWidth(2.0);
                path.stroke();
            }

        }
    }
);

impl PickerView {
    fn point(&self, event: &NSEvent) -> NSPoint {
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        NSPoint::new(
            point.x.clamp(0.0, self.ivars().size.width),
            point.y.clamp(0.0, self.ivars().size.height),
        )
    }
    fn region(&self) -> Option<ScreenCaptureRegion> {
        let start = (*self.ivars().start.borrow())?;
        let end = (*self.ivars().end.borrow())?;
        // Round inwards: a fractional boundary never includes pixels outside the drag.
        let x = start.x.min(end.x).ceil();
        let y = start.y.min(end.y).ceil();
        Some(ScreenCaptureRegion {
            x,
            y,
            width: start.x.max(end.x).floor() - x,
            height: start.y.max(end.y).floor() - y,
            display_width: self.ivars().size.width,
            display_height: self.ivars().size.height,
        })
    }
}

fn finish(token: &str, result: Result<Option<ScreenCaptureRegionSelection>, String>) {
    SESSION.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(session) = slot.as_mut().filter(|session| session.token == token) else {
            return;
        };
        let Some(sender) = session.sender.take() else {
            return;
        };
        for panel in &session.panels {
            panel.orderOut(None);
        }
        if let Some(previous) = session.previous.take() {
            previous.makeKeyWindow();
        }
        let _ = sender.send(result);
        // Keep the panel alive until a later selection; this callback may run on its view.
    });
}

pub async fn select(
    app: &AppHandle,
    source_id: Option<u32>,
) -> Result<Option<ScreenCaptureRegionSelection>, String> {
    let (sender, receiver) = oneshot::channel();
    let token = uuid::Uuid::new_v4().to_string();
    let next_token = token.clone();
    let generation = DOCUMENT_GENERATION.load(Ordering::Acquire);
    app.run_on_main_thread(move || {
        if let Err((sender, error)) = show(source_id, next_token, sender, generation) {
            let _ = sender.send(Err(error));
        }
    })
    .map_err(|_| "Could not open the region selector.".to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(120), receiver).await {
        Ok(result) => result.map_err(|_| "Region selection was cancelled.".to_string())?,
        Err(_) => {
            let _ = app.run_on_main_thread(move || finish(&token, Ok(None)));
            Err("Region selection timed out. Select a region again.".into())
        }
    }
}

fn show(
    source_id: Option<u32>,
    token: String,
    sender: Reply,
    generation: u64,
) -> Result<(), (Reply, String)> {
    if generation != DOCUMENT_GENERATION.load(Ordering::Acquire) {
        return Err((sender, "The screen sharing document changed.".into()));
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return Err((sender, "Region selection requires the main thread.".into()));
    };
    if SESSION.with(|slot| slot.borrow().as_ref().is_some_and(|s| s.sender.is_some())) {
        return Err((
            sender,
            "A region selection is already open. Complete it or press Esc.".into(),
        ));
    }
    let ids = if let Some(id) = source_id {
        vec![id]
    } else {
        let mut ids = [0_u32; 32];
        let mut count = 0_u32;
        if unsafe { CGGetActiveDisplayList(32, ids.as_mut_ptr(), &mut count) } != 0 {
            return Err((
                sender,
                "Could not list displays for region selection.".into(),
            ));
        }
        ids[..(count as usize).min(ids.len())].to_vec()
    };
    if ids.is_empty() {
        return Err((
            sender,
            "No displays are available for region selection.".into(),
        ));
    }
    let main = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let mut panels = Vec::new();
    for source_id in ids {
        let bounds = unsafe { CGDisplayBounds(source_id) };
        if unsafe { CGDisplayIsActive(source_id) } == 0
            || bounds.size.width <= 0.0
            || bounds.size.height <= 0.0
        {
            continue;
        }
        let frame = NSRect::new(
            NSPoint::new(
                bounds.origin.x,
                main.size.height - bounds.origin.y - bounds.size.height,
            ),
            bounds.size,
        );
        let panel: Retained<PickerPanel> = unsafe {
            msg_send![PickerPanel::alloc(mtm),initWithContentRect:frame,styleMask:NSWindowStyleMask::Borderless,backing:NSBackingStoreType::Buffered,defer:false]
        };
        unsafe { panel.setReleasedWhenClosed(false) };
        panel.setOpaque(false);
        panel.setBackgroundColor(Some(&NSColor::clearColor()));
        panel.setHasShadow(false);
        panel.setLevel(NSStatusWindowLevel + 1);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        panel.setSharingType(NSWindowSharingType::None);
        let view = PickerView::alloc(mtm).set_ivars(SelectionDrawing {
            start: RefCell::new(None),
            end: RefCell::new(None),
            size: bounds.size,
            source_id,
            token: token.clone(),
        });
        let view: Retained<PickerView> = unsafe {
            msg_send![super(view),initWithFrame:NSRect::new(NSPoint::new(0.0,0.0),bounds.size)]
        };
        panel.setContentView(Some(&view));
        panel.makeFirstResponder(Some(&view));
        panels.push(panel);
    }
    if panels.is_empty() {
        return Err((
            sender,
            "The selected display is no longer available.".into(),
        ));
    }
    let previous = objc2_app_kit::NSApplication::sharedApplication(mtm).keyWindow();
    // Display panels intercept only the initial explicit drawing gesture. The
    // resulting persistent frame consists solely of thin edge panels.
    for panel in &panels {
        panel.orderFrontRegardless();
    }
    if let Some(panel) = panels.first() {
        panel.makeKeyWindow();
    }
    SESSION.with(|slot| {
        *slot.borrow_mut() = Some(Session {
            panels,
            previous,
            sender: Some(sender),
            token,
            generation,
        })
    });
    Ok(())
}

pub(super) fn document_reloaded(app: &AppHandle) {
    let generation = DOCUMENT_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let _ = app.run_on_main_thread(move || {
        let token = SESSION.with(|slot| {
            slot.borrow()
                .as_ref()
                .filter(|s| s.generation < generation)
                .map(|s| s.token.clone())
        });
        if let Some(token) = token {
            finish(&token, Ok(None));
        }
    });
}

pub(super) fn shutdown() {
    DOCUMENT_GENERATION.fetch_add(1, Ordering::AcqRel);
    let token = SESSION.with(|slot| slot.borrow().as_ref().map(|s| s.token.clone()));
    if let Some(token) = token {
        finish(&token, Ok(None));
    }
}
