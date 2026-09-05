//! Native, click-through marks over the display that the user is sharing.
//!
//! AppKit objects never leave the main thread. Only the window number crosses
//! threads, allowing ScreenCaptureKit to exclude our own annotation window.

use super::{AnnotationTarget, DisplayGeometry};
use objc2::rc::{autoreleasepool, Retained};
use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSBezierPath, NSColor, NSFont, NSLineBreakMode, NSLineCapStyle,
    NSLineJoinStyle, NSPanel, NSScreen, NSStatusWindowLevel, NSTextField, NSView,
    NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowSharingType, NSWindowStyleMask,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};

static WINDOW_ID: AtomicU32 = AtomicU32::new(0);

thread_local! {
    // Reusing the panel gives capture a stable ID even while it is ordered out.
    // Its final release, including the retained content view, is on this thread.
    static PANEL: RefCell<Option<Retained<AnnotationPanel>>> = const { RefCell::new(None) };
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayIsActive(display: u32) -> u32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> NSRect;
    fn CGDisplayPixelsWide(display: u32) -> usize;
    fn CGDisplayPixelsHigh(display: u32) -> usize;
}

// NSPanel has no additional subclassing requirements. All overridden method
// signatures match AppKit, and the class inherits its main-thread restriction.
define_class!(
    #[unsafe(super(NSPanel))]
    #[name = "YorishiroScreenAnnotationPanel"]
    struct AnnotationPanel;

    impl AnnotationPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool { false }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main_window(&self) -> bool { false }

        // NSWindow normally constrains new windows below the menu bar. This
        // borderless panel must instead preserve the complete display bounds.
        #[unsafe(method(constrainFrameRect:toScreen:))]
        fn constrain_frame(&self, frame: NSRect, _screen: Option<&NSScreen>) -> NSRect {
            frame
        }
    }
);

#[derive(Debug)]
struct Drawing {
    target: AnnotationTarget,
    size: NSSize,
    label_frame: Option<NSRect>,
}

// NSView supports drawRect subclassing. Drawing only happens on the main
// thread in the graphics context provided by AppKit.
define_class!(
    #[unsafe(super(NSView))]
    #[name = "YorishiroScreenAnnotationView"]
    #[ivars = Drawing]
    struct AnnotationView;

    impl AnnotationView {
        // Capture and tool coordinates use a top-left origin. Flipping only
        // this view lets AppKit draw at the display's native backing scale.
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool { true }

        #[unsafe(method(isOpaque))]
        fn is_opaque(&self) -> bool { false }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { false }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            let drawing = self.ivars();
            let path = match drawing.target {
                AnnotationTarget::Arrow { x, y } => {
                    let arrow = arrow_points(x, y, drawing.size);
                    let path = NSBezierPath::bezierPath();
                    path.moveToPoint(arrow.tail);
                    path.lineToPoint(arrow.tip);
                    path.moveToPoint(arrow.wing_a);
                    path.lineToPoint(arrow.tip);
                    path.lineToPoint(arrow.wing_b);
                    path
                }
                AnnotationTarget::Rect { x, y, width, height } => {
                    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
                        rect(x, y, width, height),
                        6.0_f64.min(width / 4.0),
                        6.0_f64.min(height / 4.0),
                    )
                }
            };
            path.setLineCapStyle(NSLineCapStyle::Round);
            path.setLineJoinStyle(NSLineJoinStyle::Round);
            // A dark halo preserves the mark on white canvases; amber remains
            // visible on dark modeling and editing applications.
            NSColor::colorWithSRGBRed_green_blue_alpha(0.08, 0.06, 0.02, 0.92).setStroke();
            path.setLineWidth(7.0);
            path.stroke();
            NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.76, 0.23, 1.0).setStroke();
            path.setLineWidth(3.0);
            path.stroke();

            if let Some(frame) = drawing.label_frame {
                let bubble = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
                    frame, 7.0, 7.0,
                );
                NSColor::colorWithSRGBRed_green_blue_alpha(0.12, 0.10, 0.07, 0.95).setFill();
                bubble.fill();
                NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.76, 0.23, 0.85).setStroke();
                bubble.setLineWidth(1.0);
                bubble.stroke();
            }
        }
    }
);

pub(super) fn display_geometry(source_id: u32) -> Result<DisplayGeometry, String> {
    // CGDisplayBounds is the current global desktop coordinate space. Preserve
    // the same source dimensions used by capture; CGDisplayPixelsWide/High may
    // report mode pixels rather than physical Retina backing pixels.
    if unsafe { CGDisplayIsActive(source_id) } == 0 {
        return Err("The shared display is no longer active. Choose a display again.".into());
    }
    let bounds = unsafe { CGDisplayBounds(source_id) };
    let main = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let geometry = DisplayGeometry {
        source_id,
        x: bounds.origin.x,
        y: bounds.origin.y,
        width: bounds.size.width,
        height: bounds.size.height,
        pixel_width: unsafe { CGDisplayPixelsWide(source_id) },
        pixel_height: unsafe { CGDisplayPixelsHigh(source_id) },
        main_height: main.size.height,
    };
    if ![
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
        geometry.main_height,
    ]
    .iter()
    .all(|value| value.is_finite())
        || geometry.width <= 0.0
        || geometry.height <= 0.0
        || geometry.main_height <= 0.0
        || geometry.pixel_width == 0
        || geometry.pixel_height == 0
    {
        return Err("The shared display has no usable geometry.".into());
    }
    Ok(geometry)
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

/// CoreGraphics places (0, 0) at the main display's top-left; AppKit uses its
/// bottom-left. Subtracting the complete display's bottom handles displays
/// left of, above, and below the main display, including negative origins.
fn appkit_frame(geometry: DisplayGeometry) -> NSRect {
    rect(
        geometry.x,
        geometry.main_height - geometry.y - geometry.height,
        geometry.width,
        geometry.height,
    )
}

#[derive(Debug)]
struct ArrowPoints {
    tip: NSPoint,
    tail: NSPoint,
    wing_a: NSPoint,
    wing_b: NSPoint,
}

fn arrow_points(x: f64, y: f64, size: NSSize) -> ArrowPoints {
    // Put the shaft and arrowhead toward the display's interior without ever
    // clamping/moving the requested tip. This also works at all four corners.
    let scale = 1.0_f64.min(size.width / 160.0).min(size.height / 120.0);
    let dx = if x < size.width / 2.0 { 56.0 } else { -56.0 } * scale;
    let dy = if y < size.height / 2.0 { 44.0 } else { -44.0 } * scale;
    let length = dx.hypot(dy);
    let ux = dx / length;
    let uy = dy / length;
    let wing_length = 13.0 * scale;
    let wing_width = 5.0 * scale;
    ArrowPoints {
        tip: NSPoint::new(x, y),
        tail: NSPoint::new(x + dx, y + dy),
        wing_a: NSPoint::new(
            x + ux * wing_length - uy * wing_width,
            y + uy * wing_length + ux * wing_width,
        ),
        wing_b: NSPoint::new(
            x + ux * wing_length + uy * wing_width,
            y + uy * wing_length - ux * wing_width,
        ),
    }
}

fn label_frame(target: AnnotationTarget, size: NSSize, text_size: NSSize) -> NSRect {
    let margin = 8.0_f64.min(size.width / 8.0).min(size.height / 8.0);
    let width = (text_size.width.ceil() + 20.0)
        .min(300.0)
        .min(size.width - margin * 2.0);
    let height = (text_size.height.ceil() + 12.0).min(size.height - margin * 2.0);
    let (preferred_x, preferred_y) = match target {
        AnnotationTarget::Arrow { x, y } => {
            let tail = arrow_points(x, y, size).tail;
            let top = if tail.y < y {
                tail.y - height - 10.0
            } else {
                tail.y + 10.0
            };
            (tail.x - width / 2.0, top)
        }
        AnnotationTarget::Rect {
            x,
            y,
            height: target_height,
            ..
        } => {
            let top = if y >= height + margin + 8.0 {
                y - height - 8.0
            } else if y + target_height + height + margin + 8.0 <= size.height {
                y + target_height + 8.0
            } else {
                y + 8.0
            };
            (x, top)
        }
    };
    rect(
        preferred_x.clamp(margin, size.width - width - margin),
        preferred_y.clamp(margin, size.height - height - margin),
        width,
        height,
    )
}

fn create_view(
    mtm: MainThreadMarker,
    target: AnnotationTarget,
    size: NSSize,
    label: Option<&str>,
) -> Retained<AnnotationView> {
    let label = label.filter(|label| !label.trim().is_empty()).map(|label| {
        let label = NSTextField::labelWithString(&NSString::from_str(label), mtm);
        label.setFont(Some(&NSFont::boldSystemFontOfSize(13.0)));
        label.setTextColor(Some(&NSColor::whiteColor()));
        label.setEditable(false);
        label.setSelectable(false);
        label.setDrawsBackground(false);
        label.setMaximumNumberOfLines(1);
        label.setUsesSingleLineMode(true);
        if let Some(cell) = label.cell() {
            cell.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        }
        label.sizeToFit();
        label
    });
    let label_frame = label
        .as_ref()
        .map(|label| label_frame(target, size, label.frame().size));
    let view = AnnotationView::alloc(mtm).set_ivars(Drawing {
        target,
        size,
        label_frame,
    });
    // SAFETY: NSView's designated initializer takes NSRect and returns self.
    let view: Retained<AnnotationView> =
        unsafe { msg_send![super(view), initWithFrame: NSRect::new(NSPoint::ZERO, size)] };
    if let (Some(label), Some(frame)) = (label, label_frame) {
        label.setFrame(rect(
            frame.origin.x + 10.0,
            frame.origin.y + 6.0,
            (frame.size.width - 20.0).max(1.0),
            (frame.size.height - 12.0).max(1.0),
        ));
        // addSubview retains the new label for the content view's life.
        view.addSubview(&label);
    }
    view
}

fn create_panel(mtm: MainThreadMarker, frame: NSRect) -> Retained<AnnotationPanel> {
    // SAFETY: The NSPanel initializer is inherited with the same signature.
    let panel: Retained<AnnotationPanel> = unsafe {
        msg_send![AnnotationPanel::alloc(mtm),
            initWithContentRect: frame,
            styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            backing: NSBackingStoreType::Buffered,
            defer: false,
        ]
    };
    // SAFETY: Rust's Retained owns the panel; AppKit must not release it on close.
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(false);
    panel.setIgnoresMouseEvents(true);
    panel.setAcceptsMouseMovedEvents(false);
    panel.setMovable(false);
    panel.setHidesOnDeactivate(false);
    panel.setFloatingPanel(true);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setWorksWhenModal(true);
    panel.setExcludedFromWindowsMenu(true);
    panel.setAnimationBehavior(NSWindowAnimationBehavior::None);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    panel.setLevel(NSStatusWindowLevel);
    // Defense in depth for capture APIs honoring this setting. ScreenCaptureKit
    // also excludes WINDOW_ID; parent suppresses annotations during capture.
    panel.setSharingType(NSWindowSharingType::None);
    panel
}

pub(super) fn show(
    geometry: DisplayGeometry,
    target: AnnotationTarget,
    label: Option<&str>,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "Screen annotations must be updated on the main thread.".to_string())?;
    autoreleasepool(|_| {
        let size = NSSize::new(geometry.width, geometry.height);
        let view = create_view(mtm, target, size, label);
        PANEL.with(|slot| {
            let mut slot = slot.borrow_mut();
            let panel = slot.get_or_insert_with(|| create_panel(mtm, appkit_frame(geometry)));
            panel.setFrame_display(appkit_frame(geometry), false);
            panel.setContentView(Some(&view));
            let id = u32::try_from(panel.windowNumber())
                .ok()
                .filter(|id| *id != 0)
                .ok_or_else(|| "Could not obtain the screen annotation window ID.".to_string())?;
            WINDOW_ID.store(id, Ordering::Release);
            view.setNeedsDisplay(true);
            // This makes the mark visible over the foreground app without
            // activating Yorishiro or making any window key/main.
            panel.orderFrontRegardless();
            Ok(())
        })
    })
}

pub(super) fn hide() {
    // Parent runs all native annotation state transitions on Tauri's UI thread.
    // Avoid touching/creating thread-local AppKit state if miscalled.
    if MainThreadMarker::new().is_none() {
        debug_assert!(
            false,
            "Screen annotations must be hidden on the main thread"
        );
        return;
    }
    autoreleasepool(|_| {
        PANEL.with(|slot| {
            if let Some(panel) = slot.borrow().as_ref() {
                panel.orderOut(None);
                // Release labels/geometry promptly, retaining only the inert
                // window itself so capture exclusions continue to use one ID.
                panel.setContentView(None);
            }
        });
    });
}

/// The stable native ID, including while the panel is ordered out. Reading it
/// does not retain, message, or release an AppKit object on the capture thread.
pub(crate) fn window_id() -> Option<u32> {
    match WINDOW_ID.load(Ordering::Acquire) {
        0 => None,
        id => Some(id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(x: f64, y: f64, width: f64, height: f64) -> DisplayGeometry {
        DisplayGeometry {
            source_id: 1,
            x,
            y,
            width,
            height,
            pixel_width: (width * 2.0) as usize,
            pixel_height: (height * 2.0) as usize,
            main_height: 900.0,
        }
    }

    #[test]
    fn global_display_frames_preserve_negative_origins_and_vertical_offsets() {
        assert_eq!(
            appkit_frame(geometry(0.0, 0.0, 1440.0, 900.0)),
            rect(0.0, 0.0, 1440.0, 900.0)
        );
        assert_eq!(
            appkit_frame(geometry(-1920.0, -180.0, 1920.0, 1080.0)),
            rect(-1920.0, 0.0, 1920.0, 1080.0)
        );
        assert_eq!(
            appkit_frame(geometry(0.0, -1080.0, 1920.0, 1080.0)),
            rect(0.0, 900.0, 1920.0, 1080.0)
        );
        assert_eq!(
            appkit_frame(geometry(100.0, 900.0, 1920.0, 1080.0)),
            rect(100.0, -1080.0, 1920.0, 1080.0)
        );
    }

    #[test]
    fn retina_backing_pixels_do_not_scale_the_panel_frame() {
        let retina = geometry(1440.0, 200.0, 1512.0, 982.0);
        let mut standard = retina;
        standard.pixel_width = 1512;
        standard.pixel_height = 982;
        assert_eq!(appkit_frame(retina), appkit_frame(standard));
    }

    #[test]
    fn arrow_tips_remain_exact_and_heads_point_inward_at_display_edges() {
        let size = NSSize::new(1440.0, 900.0);
        for x in [0.0, 720.0, 1440.0] {
            for y in [0.0, 450.0, 900.0] {
                let arrow = arrow_points(x, y, size);
                assert_eq!(arrow.tip, NSPoint::new(x, y));
                for point in [arrow.tail, arrow.wing_a, arrow.wing_b] {
                    assert!((0.0..=size.width).contains(&point.x), "{point:?}");
                    assert!((0.0..=size.height).contains(&point.y), "{point:?}");
                }
            }
        }
    }

    #[test]
    fn labels_remain_inside_the_display_for_corner_points_and_full_display_rects() {
        let size = NSSize::new(1440.0, 900.0);
        let targets = [
            AnnotationTarget::Arrow { x: 0.0, y: 0.0 },
            AnnotationTarget::Arrow { x: 1440.0, y: 0.0 },
            AnnotationTarget::Arrow { x: 0.0, y: 900.0 },
            AnnotationTarget::Arrow {
                x: 1440.0,
                y: 900.0,
            },
            AnnotationTarget::Rect {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
            AnnotationTarget::Rect {
                x: 1430.0,
                y: 890.0,
                width: 10.0,
                height: 10.0,
            },
        ];
        for target in targets {
            let label = label_frame(target, size, NSSize::new(1200.0, 17.0));
            assert!(label.origin.x >= 8.0);
            assert!(label.origin.y >= 8.0);
            assert!(label.origin.x + label.size.width <= size.width - 8.0);
            assert!(label.origin.y + label.size.height <= size.height - 8.0);
        }
    }
}
