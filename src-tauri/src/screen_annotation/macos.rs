//! Native, click-through marks over the display that the user is sharing.
//!
//! AppKit objects never leave the main thread. Only the window number crosses
//! threads, allowing ScreenCaptureKit to exclude our own annotation window.

use super::{AnnotationTarget, DisplayGeometry};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSAttributedStringNSExtendedStringDrawing, NSBackingStoreType, NSBezierPath, NSColor, NSFont,
    NSFontAttributeName, NSForegroundColorAttributeName, NSLineCapStyle, NSLineJoinStyle, NSPanel,
    NSScreen, NSShadow, NSShadowAttributeName, NSStatusWindowLevel, NSStringDrawingOptions,
    NSStrokeColorAttributeName, NSStrokeWidthAttributeName, NSView, NSWindowAnimationBehavior,
    NSWindowCollectionBehavior, NSWindowSharingType, NSWindowStyleMask,
};
use objc2_foundation::{
    MainThreadMarker, NSAttributedString, NSDictionary, NSNumber, NSPoint, NSRect, NSSize, NSString,
};
use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};

static WINDOW_ID: AtomicU32 = AtomicU32::new(0);

// Muted green ink with a white edge stays visible on mixed backgrounds
// without another screen capture.
const ACCENT: u32 = 0x506747;
const CONTRAST: u32 = 0xffffff;
const FOREGROUND: u32 = 0x506747;
const MARK_WIDTH: f64 = 1.7;
const CONTRAST_WIDTH: f64 = 7.0;
const LABEL_FONT_SIZE: f64 = 18.0;
const LABEL_PADDING_X: f64 = 6.0;
const LABEL_PADDING_Y: f64 = 6.0;

thread_local! {
    // Reusing the panel gives capture a stable ID even while it is ordered out.
    // Its final release, including the retained content view, is on this thread.
    static PANEL: RefCell<Option<Retained<AnnotationPanel>>> = const { RefCell::new(None) };
    static LABEL_FONT: RefCell<Option<Retained<NSFont>>> = const { RefCell::new(None) };
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayIsActive(display: u32) -> u32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> NSRect;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFAllocatorNull: *const c_void;
    fn CFDataCreateWithBytesNoCopy(
        allocator: *const c_void,
        bytes: *const u8,
        length: isize,
        bytes_deallocator: *const c_void,
    ) -> *const c_void;
    fn CFRelease(value: *const c_void);
}

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontManagerCreateFontDescriptorFromData(data: *const c_void) -> *const c_void;
    fn CTFontCreateWithFontDescriptor(
        descriptor: *const c_void,
        size: f64,
        matrix: *const c_void,
    ) -> *mut c_void;
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
    label: Option<LabelDrawing>,
}

#[derive(Debug)]
struct LabelDrawing {
    passes: [Retained<NSAttributedString>; 2],
    text_rect: NSRect,
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
            let path = annotation_path(drawing.target, drawing.size);
            path.setLineCapStyle(NSLineCapStyle::Round);
            path.setLineJoinStyle(NSLineJoinStyle::Round);
            // A white backing separates the green stroke from dark content.
            // No background sampling or animation.
            color(CONTRAST, 1.0).setStroke();
            path.setLineWidth(CONTRAST_WIDTH);
            path.stroke();
            color(ACCENT, 1.0).setStroke();
            path.setLineWidth(MARK_WIDTH);
            path.stroke();
            if let Some(label) = &drawing.label {
                for text in &label.passes {
                    text.drawWithRect_options_context(label.text_rect, label_options(), None);
                }
            }
        }
    }
);

pub(super) fn display_geometry(source_id: u32) -> Result<DisplayGeometry, String> {
    // Positions remain in current desktop points; capture validation uses the
    // same oriented backing-pixel dimensions as ScreenCaptureKit's output size.
    if unsafe { CGDisplayIsActive(source_id) } == 0 {
        return Err("The shared display is no longer active. Choose a display again.".into());
    }
    let bounds = unsafe { CGDisplayBounds(source_id) };
    let main = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let (pixel_width, pixel_height) = crate::screen_capture::display_pixel_dimensions(source_id)?;
    let geometry = DisplayGeometry {
        source_id,
        x: bounds.origin.x,
        y: bounds.origin.y,
        width: bounds.size.width,
        height: bounds.size.height,
        pixel_width,
        pixel_height,
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

fn color(rgb: u32, alpha: f64) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(
        ((rgb >> 16) & 255) as f64 / 255.0,
        ((rgb >> 8) & 255) as f64 / 255.0,
        (rgb & 255) as f64 / 255.0,
        alpha,
    )
}

fn annotation_font(_mtm: MainThreadMarker) -> Retained<NSFont> {
    LABEL_FONT.with(|slot| {
        slot.borrow_mut()
            .get_or_insert_with(|| {
                bundled_font()
                    .or_else(|| {
                        ["HiraMaruProN-W4", "HiraginoSans-W4"]
                            .iter()
                            .find_map(|name| {
                                NSFont::fontWithName_size(
                                    &NSString::from_str(name),
                                    LABEL_FONT_SIZE,
                                )
                            })
                    })
                    .unwrap_or_else(|| NSFont::systemFontOfSize(LABEL_FONT_SIZE))
            })
            .clone()
    })
}

fn bundled_font() -> Option<Retained<NSFont>> {
    static FONT: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/assets/fonts/KleeOne-SemiBold.ttf"
    ));
    // A data-backed descriptor needs no global font registration or temporary
    // file. AppKit supplies missing-glyph fallback through its normal cascade.
    // SAFETY: The immutable bytes are static and kCFAllocatorNull prevents
    // CoreFoundation from freeing them. Each Create is balanced by Release,
    // except the CTFont whose +1 ownership transfers to toll-free NSFont.
    unsafe {
        let data = CFDataCreateWithBytesNoCopy(
            std::ptr::null(),
            FONT.as_ptr(),
            FONT.len() as isize,
            kCFAllocatorNull,
        );
        if data.is_null() {
            return None;
        }
        let descriptor = CTFontManagerCreateFontDescriptorFromData(data);
        let font = if descriptor.is_null() {
            None
        } else {
            let font =
                CTFontCreateWithFontDescriptor(descriptor, LABEL_FONT_SIZE, std::ptr::null());
            CFRelease(descriptor);
            Retained::from_raw(font.cast::<NSFont>())
        };
        CFRelease(data);
        font.filter(|font| font.fontName().to_string() == "KleeOne-SemiBold")
    }
}

fn label_text(text: &str, mtm: MainThreadMarker) -> [Retained<NSAttributedString>; 2] {
    let font = annotation_font(mtm);
    let ink = color(FOREGROUND, 1.0);
    let edge = color(CONTRAST, 1.0);
    // Negative stroke width draws both fill and outline; the unit is percent
    // of the font size. A 3.24 pt white stroke surrounds the pale letterforms.
    let stroke = NSNumber::new_f64(-18.0);
    // Thicken the handwriting slightly while keeping Japanese counters open.
    let ink_stroke = NSNumber::new_f64(-2.5);
    let shadow = NSShadow::new();
    shadow.setShadowColor(Some(&color(CONTRAST, 0.45)));
    shadow.setShadowOffset(NSSize::new(0.0, -0.5));
    shadow.setShadowBlurRadius(1.5);
    let values: [&AnyObject; 5] = [&font, &edge, &edge, &stroke, &shadow];
    // SAFETY: Each AppKit attribute has its documented value type. The
    // attributed strings retain the values they use.
    unsafe {
        let attributes = NSDictionary::from_slices(
            &[
                NSFontAttributeName,
                NSForegroundColorAttributeName,
                NSStrokeColorAttributeName,
                NSStrokeWidthAttributeName,
                NSShadowAttributeName,
            ],
            &values,
        );
        let string = NSString::from_str(text);
        let outline = NSAttributedString::new_with_attributes(&string, &attributes);
        let ink_values: [&AnyObject; 4] = [&font, &ink, &ink, &ink_stroke];
        let ink_attributes = NSDictionary::from_slices(
            &[
                NSFontAttributeName,
                NSForegroundColorAttributeName,
                NSStrokeColorAttributeName,
                NSStrokeWidthAttributeName,
            ],
            &ink_values,
        );
        // Drawing the fill separately keeps the white outline outside the fine
        // pen strokes, instead of letting it cover their pale centers.
        [
            outline,
            NSAttributedString::new_with_attributes(&string, &ink_attributes),
        ]
    }
}

fn annotation_path(target: AnnotationTarget, size: NSSize) -> Retained<NSBezierPath> {
    match target {
        AnnotationTarget::Arrow { x, y } => {
            let arrow = arrow_points(x, y, size);
            let path = NSBezierPath::bezierPath();
            path.moveToPoint(arrow.tail);
            path.curveToPoint_controlPoint1_controlPoint2(
                arrow.tip,
                arrow.control_a,
                arrow.control_b,
            );
            path.moveToPoint(arrow.wing_a);
            path.lineToPoint(arrow.tip);
            path.lineToPoint(arrow.wing_b);
            path
        }
        AnnotationTarget::Rect {
            x,
            y,
            width,
            height,
        } => {
            // Small, fixed inward bows suggest a single drawn stroke. Corners
            // remain exact and every control point stays inside the target box.
            let bend = 1.8_f64.min(width * 0.012).min(height * 0.025);
            let path = NSBezierPath::bezierPath();
            path.moveToPoint(NSPoint::new(x, y));
            for (end, a, b) in [
                (
                    (x + width, y),
                    (x + width * 0.31, y + bend * 0.4),
                    (x + width * 0.71, y + bend),
                ),
                (
                    (x + width, y + height),
                    (x + width - bend * 0.45, y + height * 0.28),
                    (x + width - bend * 0.85, y + height * 0.73),
                ),
                (
                    (x, y + height),
                    (x + width * 0.68, y + height - bend * 0.6),
                    (x + width * 0.29, y + height - bend * 0.2),
                ),
                (
                    (x, y),
                    (x + bend * 0.5, y + height * 0.67),
                    (x + bend * 0.15, y + height * 0.26),
                ),
            ] {
                path.curveToPoint_controlPoint1_controlPoint2(
                    NSPoint::new(end.0, end.1),
                    NSPoint::new(a.0, a.1),
                    NSPoint::new(b.0, b.1),
                );
            }
            path.closePath();
            path
        }
        AnnotationTarget::Ellipse {
            x,
            y,
            width,
            height,
        } => {
            // Four exact extrema retain the requested bounding box, while
            // slightly unequal tangents give the oval a quiet, drawn cadence.
            let shift_x = (width * 0.025).min(4.0);
            let shift_y = (height * 0.02).min(2.5);
            let top = NSPoint::new(x + width / 2.0 - shift_x, y);
            let right = NSPoint::new(x + width, y + height / 2.0 - shift_y);
            let bottom = NSPoint::new(x + width / 2.0 + shift_x, y + height);
            let left = NSPoint::new(x, y + height / 2.0 + shift_y);
            let path = NSBezierPath::bezierPath();
            path.moveToPoint(top);
            for (end, a, b) in [
                (
                    right,
                    NSPoint::new(top.x + (right.x - top.x) * 0.59, top.y),
                    NSPoint::new(right.x, right.y - (right.y - top.y) * 0.50),
                ),
                (
                    bottom,
                    NSPoint::new(right.x, right.y + (bottom.y - right.y) * 0.60),
                    NSPoint::new(bottom.x + (right.x - bottom.x) * 0.49, bottom.y),
                ),
                (
                    left,
                    NSPoint::new(bottom.x - (bottom.x - left.x) * 0.56, bottom.y),
                    NSPoint::new(left.x, left.y + (bottom.y - left.y) * 0.55),
                ),
                (
                    top,
                    NSPoint::new(left.x, left.y - (left.y - top.y) * 0.57),
                    NSPoint::new(top.x - (top.x - left.x) * 0.52, top.y),
                ),
            ] {
                path.curveToPoint_controlPoint1_controlPoint2(end, a, b);
            }
            path.closePath();
            path
        }
    }
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
    control_a: NSPoint,
    control_b: NSPoint,
    wing_a: NSPoint,
    wing_b: NSPoint,
}

fn arrow_points(x: f64, y: f64, size: NSSize) -> ArrowPoints {
    // Put the shaft and arrowhead toward the display's interior without ever
    // clamping/moving the requested tip. This also works at all four corners.
    let scale = 1.0_f64.min(size.width / 232.0).min(size.height / 160.0);
    let dx = if x < size.width / 2.0 { 92.0 } else { -92.0 } * scale;
    let dy = if y < size.height / 2.0 { 56.0 } else { -56.0 } * scale;
    let control_a = NSPoint::new(x + dx * 0.64, y + dy * 0.96);
    let control_b = NSPoint::new(x + dx * 0.18, y + dy * 0.28);
    // Aim the open head along the curve's final tangent, not its chord. The
    // narrow wings remain inside the display even when the tip is at a corner.
    let length = (dx * 0.18).hypot(dy * 0.28);
    let ux = dx * 0.18 / length;
    let uy = dy * 0.28 / length;
    let wing_length = 10.5 * scale;
    let wing_width = 3.4 * scale;
    ArrowPoints {
        tip: NSPoint::new(x, y),
        tail: NSPoint::new(x + dx, y + dy),
        control_a,
        control_b,
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
    let width = (text_size.width.ceil() + LABEL_PADDING_X * 2.0).min(size.width - margin * 2.0);
    let height = (text_size.height.ceil() + LABEL_PADDING_Y * 2.0).min(size.height - margin * 2.0);
    let (preferred_x, preferred_y) = match target {
        AnnotationTarget::Arrow { x, y } => {
            let tail = arrow_points(x, y, size).tail;
            let left = if tail.x < x {
                tail.x - width - 10.0
            } else {
                tail.x + 10.0
            };
            (left, tail.y - height / 2.0)
        }
        AnnotationTarget::Rect {
            x,
            y,
            height: target_height,
            ..
        }
        | AnnotationTarget::Ellipse {
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

fn label_options() -> NSStringDrawingOptions {
    NSStringDrawingOptions::UsesLineFragmentOrigin | NSStringDrawingOptions::UsesFontLeading
}

fn create_view(
    mtm: MainThreadMarker,
    target: AnnotationTarget,
    size: NSSize,
    label: Option<&str>,
) -> Retained<AnnotationView> {
    let label = label.filter(|label| !label.trim().is_empty()).map(|label| {
        let passes = label_text(label, mtm);
        let margin = 8.0_f64.min(size.width / 8.0).min(size.height / 8.0);
        let available_width = (size.width - 2.0 * (margin + LABEL_PADDING_X)).max(1.0);
        // Measure and draw with the same multiline layout options. NSTextField's
        // single-line cell clips tall handwriting and strokes even if its outer
        // frame is enlarged. Drawing in the full overlay avoids that cell clip.
        let bounds = passes[1].boundingRectWithSize_options_context(
            NSSize::new(available_width, f64::MAX),
            label_options(),
            None,
        );
        let frame = label_frame(target, size, bounds.size);
        LabelDrawing {
            passes,
            // Keep the measured wrapping width: tightening it to a rounded
            // glyph width can move the last character onto an extra line.
            // The label frame reserves real space around the glyphs for the
            // outline and shadow, rather than adding space inside a text cell.
            text_rect: rect(
                frame.origin.x + LABEL_PADDING_X - bounds.origin.x,
                frame.origin.y + LABEL_PADDING_Y - bounds.origin.y,
                available_width,
                bounds.size.height.ceil(),
            ),
        }
    });
    let view = AnnotationView::alloc(mtm).set_ivars(Drawing {
        target,
        size,
        label,
    });
    // SAFETY: NSView's designated initializer takes NSRect and returns self.
    unsafe { msg_send![super(view), initWithFrame: NSRect::new(NSPoint::ZERO, size)] }
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
    // also excludes WINDOW_ID; new annotations wait until capture completes.
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
        for size in [NSSize::new(1440.0, 900.0), NSSize::new(80.0, 48.0)] {
            for x in [0.0, size.width / 2.0, size.width] {
                for y in [0.0, size.height / 2.0, size.height] {
                    let arrow = arrow_points(x, y, size);
                    assert_eq!(arrow.tip, NSPoint::new(x, y));
                    for point in [
                        arrow.tail,
                        arrow.control_a,
                        arrow.control_b,
                        arrow.wing_a,
                        arrow.wing_b,
                    ] {
                        assert!((0.0..=size.width).contains(&point.x), "{point:?}");
                        assert!((0.0..=size.height).contains(&point.y), "{point:?}");
                    }
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
            AnnotationTarget::Ellipse {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
            AnnotationTarget::Ellipse {
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

    #[test]
    fn hand_drawn_outlines_preserve_wide_tall_and_small_target_bounds() {
        for bounds in [
            rect(100.0, 200.0, 240.0, 80.0),
            rect(0.0, 0.0, 40.0, 200.0),
            rect(10.0, 20.0, 0.5, 0.75),
        ] {
            for target in [
                AnnotationTarget::Rect {
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                },
                AnnotationTarget::Ellipse {
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                },
            ] {
                let path = annotation_path(target, NSSize::new(1440.0, 900.0));
                let actual = path.bounds();
                for (actual, expected) in [
                    (actual.origin.x, bounds.origin.x),
                    (actual.origin.y, bounds.origin.y),
                    (actual.size.width, bounds.size.width),
                    (actual.size.height, bounds.size.height),
                ] {
                    // AppKit computes cubic extrema with floating-point rounding.
                    assert!((actual - expected).abs() < 1e-8);
                }
                assert!(path.containsPoint(NSPoint::new(
                    bounds.origin.x + bounds.size.width / 2.0,
                    bounds.origin.y + bounds.size.height / 2.0,
                )));
                if matches!(target, AnnotationTarget::Ellipse { .. }) {
                    assert!(!path.containsPoint(bounds.origin));
                }
            }
        }
    }

    #[test]
    fn repeated_hand_drawn_paths_have_identical_curves_without_jitter() {
        use objc2_app_kit::NSBezierPathElement;
        let size = NSSize::new(1440.0, 900.0);
        for target in [
            AnnotationTarget::Arrow { x: 0.0, y: 900.0 },
            AnnotationTarget::Rect {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
            AnnotationTarget::Ellipse {
                x: 180.0,
                y: 240.0,
                width: 320.0,
                height: 180.0,
            },
        ] {
            let first = annotation_path(target, size);
            let second = annotation_path(target, size);
            assert_eq!(first.elementCount(), second.elementCount());
            let mut curves = 0;
            for index in 0..first.elementCount() {
                let mut a = [NSPoint::ZERO; 3];
                let mut b = [NSPoint::ZERO; 3];
                // SAFETY: AppKit writes at most three points per path element.
                let (kind_a, kind_b) = unsafe {
                    (
                        first.elementAtIndex_associatedPoints(index, a.as_mut_ptr()),
                        second.elementAtIndex_associatedPoints(index, b.as_mut_ptr()),
                    )
                };
                assert_eq!(kind_a, kind_b);
                assert_eq!(a, b);
                if kind_a == NSBezierPathElement::CubicCurveTo {
                    curves += 1;
                }
            }
            assert!(curves > 0);
        }
    }

    #[test]
    fn arrow_labels_do_not_cover_the_target_even_with_long_text() {
        let size = NSSize::new(1440.0, 900.0);
        for x in [0.0, 720.0, 1440.0] {
            for y in [0.0, 450.0, 900.0] {
                let frame = label_frame(
                    AnnotationTarget::Arrow { x, y },
                    size,
                    NSSize::new(1200.0, 15.0),
                );
                let covers_target = x >= frame.origin.x
                    && x <= frame.origin.x + frame.size.width
                    && y >= frame.origin.y
                    && y <= frame.origin.y + frame.size.height;
                assert!(!covers_target, "label {frame:?} covers ({x}, {y})");
            }
        }
    }
}
