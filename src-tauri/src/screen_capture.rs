//! Host-owned, opt-in desktop snapshots for the shared screen companion.
//!
//! Listing displays never captures pixels or requests permission. Only the explicit
//! permission command may show the macOS prompt; individual captures only preflight
//! permission. Frames are bounded JPEGs kept in memory and are never logged or saved.

use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod region_frame;
#[cfg(target_os = "macos")]
mod region_picker;
mod selection;
pub use selection::{ScreenCaptureRegion, ScreenCaptureSelection};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureRegionSelection {
    pub source_id: u32,
    pub region: ScreenCaptureRegion,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScreenCaptureSourceKind {
    #[default]
    Display,
    Window,
}
use tauri::Manager;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureSource {
    pub kind: ScreenCaptureSourceKind,
    pub id: u32,
    pub name: String,
    pub width: usize,
    pub height: usize,
}

// Intentionally no Debug implementation: the data URL contains private pixels.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureFrame {
    pub selection_kind: &'static str,
    pub frame_id: String,
    pub pointers_enabled: bool,
    pub pointer_frame_valid: bool,
    pub pointer_epoch: u64,
    pub source_id: u32,
    pub source_name: String,
    pub captured_at: u64,
    pub data_url: String,
    pub width: usize,
    pub height: usize,
}

const UNSUPPORTED: &str = "Screen sharing requires macOS 14 or later.";

fn require_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Screen sharing is available only to the main application window.".into())
    }
}

#[tauri::command]
pub async fn screen_capture_list_sources(
    window: tauri::WebviewWindow,
    kind: Option<ScreenCaptureSourceKind>,
) -> Result<Vec<ScreenCaptureSource>, String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    return match kind.unwrap_or_default() {
        ScreenCaptureSourceKind::Display => macos::list_sources(),
        ScreenCaptureSourceKind::Window => {
            macos::list_windows(host_window_id(&window).await?).await
        }
    };
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err(UNSUPPORTED.into())
    }
}

/// Shows an AppKit drag selector without capturing or storing any desktop pixels.
#[tauri::command]
pub async fn screen_capture_select_region(
    window: tauri::WebviewWindow,
    source_id: Option<u32>,
) -> Result<Option<ScreenCaptureRegionSelection>, String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    {
        macos::ensure_supported()?;
        region_picker::select(window.app_handle(), source_id).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_id;
        Err(UNSUPPORTED.into())
    }
}

/// Keep exactly the user's explicitly drawn rectangle visible while sharing.
#[tauri::command]
pub async fn screen_capture_region_frame_open(
    window: tauri::WebviewWindow,
    share_id: String,
    source_id: u32,
    region: ScreenCaptureRegion,
) -> Result<(), String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    {
        macos::ensure_supported()?;
        region_frame::open(window.app_handle(), share_id, source_id, region).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (share_id, source_id, region);
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn screen_capture_region_frame_close(
    window: tauri::WebviewWindow,
    share_id: String,
) -> Result<(), String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    return region_frame::close(window.app_handle(), share_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = share_id;
        Err(UNSUPPORTED.into())
    }
}

pub(crate) fn region_frame_document_reloaded(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        region_frame::document_reloaded(app);
        region_picker::document_reloaded(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub(crate) fn shutdown_region_frame() {
    #[cfg(target_os = "macos")]
    {
        region_frame::shutdown();
        region_picker::shutdown();
    }
}

/// Called only by the host's user-initiated Start sharing control.
#[tauri::command]
pub async fn screen_capture_request_permission(
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    require_host(&window)?;
    #[cfg(target_os = "macos")]
    {
        macos::ensure_supported()?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = sender.send(macos::request_permission());
            })
            .map_err(|_| "Could not request screen recording permission.".to_string())?;
        receiver
            .await
            .map_err(|_| "Screen recording permission request was cancelled.".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn screen_capture_frame(
    window: tauri::WebviewWindow,
    source_id: u32,
    share_id: String,
) -> Result<ScreenCaptureFrame, String> {
    require_host(&window)?;
    let guard =
        crate::screen_annotation::begin_capture(window.app_handle(), share_id, source_id).await?;
    #[cfg(target_os = "macos")]
    let mut frame = macos::capture(
        source_id,
        guard.selection.clone(),
        guard.excluded_window,
        if matches!(guard.selection, ScreenCaptureSelection::Window) {
            Some(host_window_id(&window).await?)
        } else {
            None
        },
        crate::screen_preview::capture_guard(window.app_handle()).await?,
        region_frame::capture_guard(window.app_handle()).await?,
    )
    .await?;
    #[cfg(not(target_os = "macos"))]
    let mut frame = unsupported_capture().await?;
    let reference = crate::screen_annotation::register_frame(&guard, &frame).await?;
    frame.frame_id = reference.frame_id;
    frame.pointers_enabled = reference.pointers_enabled;
    frame.pointer_frame_valid = reference.pointer_frame_valid;
    frame.pointer_epoch = reference.pointer_epoch;
    Ok(frame)
}

#[cfg(not(target_os = "macos"))]
async fn unsupported_capture() -> Result<ScreenCaptureFrame, String> {
    Err(UNSUPPORTED.into())
}

/// Resolve the authenticated host's native ID on the event-loop thread.
/// Only this window, never another window with the same title, may be self-shared.
#[cfg(target_os = "macos")]
async fn host_window_id(window: &tauri::WebviewWindow) -> Result<u32, String> {
    require_host(window)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            use objc2::{msg_send, runtime::AnyObject};
            let result = unsafe {
                let view: *mut AnyObject = webview.inner().cast();
                let native_window: *mut AnyObject = msg_send![view, window];
                if native_window.is_null() {
                    Err("Main native window unavailable for screen sharing".to_string())
                } else {
                    let number: isize = msg_send![native_window, windowNumber];
                    u32::try_from(number)
                        .ok()
                        .filter(|number| *number != 0)
                        .ok_or_else(|| "Main native window ID unavailable".to_string())
                }
            };
            let _ = sender.send(result);
        })
        .map_err(|_| "Could not identify the main window for screen sharing")?;
    receiver
        .await
        .map_err(|_| "Main window identification cancelled")?
}

#[cfg(any(target_os = "macos", test))]
fn shareable_window_owner(pid: i32, id: u32, host_window_id: Option<u32>) -> bool {
    pid != std::process::id() as i32 || (id != 0 && Some(id) == host_window_id)
}

const MAX_IMAGE_EDGE: usize = 2560;
pub(crate) const MAX_JPEG_BYTES: usize = 8 * 1024 * 1024;

#[cfg(target_os = "macos")]
fn excluded_capture_window(id: u32, pointer: Option<u32>, preview: Option<u32>) -> bool {
    Some(id) == pointer || Some(id) == preview
}

/// Capture and pointer validation must agree on the current backing-pixel size.
#[cfg(target_os = "macos")]
pub(crate) fn display_pixel_dimensions(source_id: u32) -> Result<(usize, usize), String> {
    macos::display_pixel_dimensions(source_id)
}

#[cfg(any(target_os = "macos", test))]
fn oriented_pixel_dimensions(
    pixels: (usize, usize),
    bounds: (f64, f64),
) -> Result<(usize, usize), String> {
    if pixels.0 == 0
        || pixels.1 == 0
        || !bounds.0.is_finite()
        || !bounds.1.is_finite()
        || bounds.0 <= 0.0
        || bounds.1 <= 0.0
    {
        return Err("The selected display has no usable pixel dimensions.".into());
    }
    // Mode dimensions can describe the unrotated mode. Match the current desktop
    // orientation, allowing one pixel of rounding without stretching or cropping.
    let matches = |(width, height): (usize, usize)| {
        (width as f64 * bounds.1 - height as f64 * bounds.0).abs() <= bounds.0.max(bounds.1)
    };
    if matches(pixels) {
        Ok(pixels)
    } else if matches((pixels.1, pixels.0)) {
        Ok((pixels.1, pixels.0))
    } else {
        Err("The display mode changed. Refresh the display list and try again.".into())
    }
}

pub(crate) fn bounded_dimensions(width: usize, height: usize) -> Result<(usize, usize), String> {
    if width == 0 || height == 0 {
        return Err("The selected display has no visible area.".into());
    }
    let longest = width.max(height);
    if longest <= MAX_IMAGE_EDGE {
        return Ok((width, height));
    }
    // Floating point avoids overflow even for malformed display dimensions.
    let scale = MAX_IMAGE_EDGE as f64 / longest as f64;
    Ok((
        ((width as f64 * scale).floor() as usize).clamp(1, MAX_IMAGE_EDGE),
        ((height as f64 * scale).floor() as usize).clamp(1, MAX_IMAGE_EDGE),
    ))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        bounded_dimensions, ScreenCaptureFrame, ScreenCaptureSelection, ScreenCaptureSource,
        ScreenCaptureSourceKind, MAX_IMAGE_EDGE,
    };
    use base64::Engine;
    use block2::RcBlock;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, AnyThread};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImageCompressionFactor};
    use objc2_foundation::{
        NSArray, NSData, NSDictionary, NSNumber, NSPoint, NSRect, NSSize, NSString,
    };
    use std::ffi::{c_void, CStr};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::sync::oneshot;

    const PERMISSION_DENIED: &str = "Screen recording permission is not granted. Enable Yorishiro in System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on older macOS), then restart Yorishiro if requested.";
    use super::MAX_JPEG_BYTES;
    static CAPTURE_BUSY: AtomicBool = AtomicBool::new(false);

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetActiveDisplayList(max_displays: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> NSRect;
        fn CGDisplayCopyDisplayMode(display: u32) -> *const c_void;
        fn CGDisplayModeGetPixelWidth(mode: *const c_void) -> usize;
        fn CGDisplayModeGetPixelHeight(mode: *const c_void) -> usize;
        fn CGDisplayModeRelease(mode: *const c_void);
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
    }

    /// Resolve the screenshot API at runtime so older macOS can still launch the
    /// app. The fixed system framework is kept loaded for the application's life.
    pub(super) fn ensure_supported() -> Result<(), String> {
        static LOADED: OnceLock<bool> = OnceLock::new();
        let loaded = LOADED.get_or_init(|| unsafe {
            !libc::dlopen(
                c"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit".as_ptr(),
                libc::RTLD_NOW | libc::RTLD_LOCAL,
            )
            .is_null()
        });
        if *loaded && AnyClass::get(c"SCScreenshotManager").is_some() {
            Ok(())
        } else {
            Err(super::UNSUPPORTED.into())
        }
    }

    fn sc_class(name: &CStr) -> Result<&'static AnyClass, String> {
        AnyClass::get(name).ok_or_else(|| super::UNSUPPORTED.into())
    }

    pub(super) fn display_pixel_dimensions(source_id: u32) -> Result<(usize, usize), String> {
        // CGDisplayPixelsWide/High can return the logical mode size on Retina.
        // SCStreamConfiguration requires output pixels, so use the backing size.
        let mode = unsafe { CGDisplayCopyDisplayMode(source_id) };
        if mode.is_null() {
            return Err("The selected display mode is unavailable. Choose a display again.".into());
        }
        let pixels = unsafe {
            let size = (
                CGDisplayModeGetPixelWidth(mode),
                CGDisplayModeGetPixelHeight(mode),
            );
            CGDisplayModeRelease(mode);
            size
        };
        let bounds = unsafe { CGDisplayBounds(source_id) };
        super::oriented_pixel_dimensions(pixels, (bounds.size.width, bounds.size.height))
    }

    pub(super) fn list_sources() -> Result<Vec<ScreenCaptureSource>, String> {
        ensure_supported()?;
        // CoreGraphics display metadata does not require screen recording access.
        let mut ids = [0_u32; 32];
        let mut count = 0;
        let result =
            unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
        if result != 0 {
            return Err(format!(
                "Could not list displays (CoreGraphics error {result})."
            ));
        }
        let primary = unsafe { CGMainDisplayID() };
        let mut displays = ids[..(count as usize).min(ids.len())]
            .iter()
            .enumerate()
            .filter_map(|(index, id)| {
                // A different display disconnecting must not block the selected
                // one. The chosen display is still revalidated before capture.
                let (width, height) = display_pixel_dimensions(*id).ok()?;
                Some(ScreenCaptureSource {
                    kind: ScreenCaptureSourceKind::Display,
                    id: *id,
                    name: format!(
                        "Display {}{}",
                        index + 1,
                        if *id == primary { " (Main)" } else { "" }
                    ),
                    width,
                    height,
                })
            })
            .collect::<Vec<_>>();
        displays.sort_by_key(|display| display.id != primary);
        Ok(displays)
    }

    pub(super) async fn list_windows(
        host_window_id: u32,
    ) -> Result<Vec<ScreenCaptureSource>, String> {
        ensure_supported()?;
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(PERMISSION_DENIED.into());
        }
        let (sender, receiver) = oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        {
            let callback = RcBlock::new(move |content: *mut AnyObject, error: *mut AnyObject| {
                let result = autoreleasepool(|_| {
                    if !error.is_null() || content.is_null() {
                        return Err(capture_error(error));
                    }
                    let mut result = Vec::new();
                    unsafe {
                        let windows: *mut AnyObject = msg_send![content, windows];
                        if windows.is_null() {
                            return Ok(result);
                        }
                        let count: usize = msg_send![windows, count];
                        for index in 0..count {
                            let window: *mut AnyObject = msg_send![windows, objectAtIndex: index];
                            if let Some(source) = window_source(window, Some(host_window_id)) {
                                result.push(source);
                            }
                        }
                    }
                    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                    Ok(result)
                });
                if let Ok(mut sender) = sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            });
            unsafe {
                let _: () = msg_send![sc_class(c"SCShareableContent")?, getShareableContentWithCompletionHandler: &*callback];
            }
        }
        tokio::time::timeout(Duration::from_secs(15), receiver)
            .await
            .map_err(|_| "Window enumeration timed out. Refresh and try again.".to_string())?
            .map_err(|_| "Window enumeration was cancelled.".to_string())?
    }

    unsafe fn window_source(
        window: *mut AnyObject,
        host_window_id: Option<u32>,
    ) -> Option<ScreenCaptureSource> {
        let on_screen: Bool = msg_send![window, isOnScreen];
        let layer: isize = msg_send![window, windowLayer];
        let app: *mut AnyObject = msg_send![window, owningApplication];
        if !on_screen.as_bool() || layer != 0 || app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processID];
        let id: u32 = msg_send![window, windowID];
        // Offer the authenticated main window, excluding all our auxiliary windows.
        if !super::shareable_window_owner(pid, id, host_window_id) {
            return None;
        }
        let frame: NSRect = msg_send![window, frame];
        if !frame.size.width.is_finite()
            || !frame.size.height.is_finite()
            || frame.size.width < 1.0
            || frame.size.height < 1.0
        {
            return None;
        }
        let title: Option<Retained<NSString>> = msg_send![window, title];
        let app_name: Option<Retained<NSString>> = msg_send![app, applicationName];
        let app_name = app_name
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Application".into());
        let title = title.map(|s| s.to_string()).unwrap_or_default();
        Some(ScreenCaptureSource {
            id,
            kind: ScreenCaptureSourceKind::Window,
            name: if title.trim().is_empty() {
                app_name
            } else {
                format!("{app_name} — {title}")
            },
            width: frame.size.width.ceil() as usize,
            height: frame.size.height.ceil() as usize,
        })
    }

    pub(super) fn request_permission() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() }
    }

    struct BusyGuard;

    impl Drop for BusyGuard {
        fn drop(&mut self) {
            CAPTURE_BUSY.store(false, Ordering::Release);
        }
    }

    struct CaptureRequest {
        host_window_id: Option<u32>,
        // Retain exclusion through the native completion callback, even after timeout.
        _preview_guard: crate::screen_preview::CaptureGuard,
        frame_guard: super::region_frame::CaptureGuard,
        cancelled: AtomicBool,
        sender: Mutex<Option<oneshot::Sender<Result<ScreenCaptureFrame, String>>>>,
        // The guard is held by the native callbacks, including after a timeout.
        // A late OS callback cannot cause overlapping captures to accumulate.
        _busy: BusyGuard,
    }

    impl CaptureRequest {
        fn complete(&self, result: Result<ScreenCaptureFrame, String>) {
            if let Ok(mut sender) = self.sender.lock() {
                if let Some(sender) = sender.take() {
                    if !self.cancelled.load(Ordering::Acquire) {
                        let _ = sender.send(result);
                    }
                }
            }
        }
    }

    struct CancelOnDrop(Arc<CaptureRequest>);

    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.cancelled.store(true, Ordering::Release);
        }
    }

    pub(super) async fn capture(
        source_id: u32,
        selection: ScreenCaptureSelection,
        excluded_window: Option<u32>,
        host_window_id: Option<u32>,
        preview_guard: crate::screen_preview::CaptureGuard,
        frame_guard: super::region_frame::CaptureGuard,
    ) -> Result<ScreenCaptureFrame, String> {
        ensure_supported()?;
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return Err(PERMISSION_DENIED.into());
        }
        let source = if matches!(selection, ScreenCaptureSelection::Window) {
            ScreenCaptureSource {
                id: source_id,
                kind: ScreenCaptureSourceKind::Window,
                name: String::new(),
                width: 1,
                height: 1,
            }
        } else {
            list_sources()?
                .into_iter()
                .find(|source| source.id == source_id)
                .ok_or_else(|| {
                    "The selected display is no longer available. Choose a display again."
                        .to_string()
                })?
        };
        selection.validate()?;
        CAPTURE_BUSY
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "A screen capture is already in progress.".to_string())?;
        let (sender, receiver) = oneshot::channel();
        let excluded_preview = preview_guard.excluded_window;
        let request = Arc::new(CaptureRequest {
            host_window_id,
            _preview_guard: preview_guard,
            frame_guard,
            cancelled: AtomicBool::new(false),
            sender: Mutex::new(Some(sender)),
            _busy: BusyGuard,
        });
        let _cancel = CancelOnDrop(request.clone());
        autoreleasepool(|_| {
            begin_capture(
                request,
                source,
                selection,
                excluded_window,
                excluded_preview,
            )
        })?;
        tokio::time::timeout(Duration::from_secs(15), receiver)
            .await
            .map_err(|_| "Screen capture timed out. Stop sharing and try again.".to_string())?
            .map_err(|_| "Screen capture was cancelled.".to_string())?
    }

    fn begin_capture(
        request: Arc<CaptureRequest>,
        source: ScreenCaptureSource,
        selection: ScreenCaptureSelection,
        excluded_window: Option<u32>,
        excluded_preview: Option<u32>,
    ) -> Result<(), String> {
        let content_class = sc_class(c"SCShareableContent")?;
        let callback = RcBlock::new(move |content: *mut AnyObject, error: *mut AnyObject| {
            autoreleasepool(|_| {
                if request.cancelled.load(Ordering::Acquire) {
                    return;
                }
                if !error.is_null() || content.is_null() {
                    request.complete(Err(capture_error(error)));
                    return;
                }
                // SCShareableContent owns the display objects throughout this
                // callback. The filter retains the selected display after it.
                let result = unsafe {
                    capture_from_content(
                        content,
                        request.clone(),
                        source.clone(),
                        selection.clone(),
                        excluded_window,
                        excluded_preview,
                    )
                };
                if let Err(error) = result {
                    request.complete(Err(error));
                }
            });
        });
        unsafe {
            let _: () =
                msg_send![content_class, getShareableContentWithCompletionHandler: &*callback];
        }
        Ok(())
    }

    unsafe fn capture_from_content(
        content: *mut AnyObject,
        request: Arc<CaptureRequest>,
        mut source: ScreenCaptureSource,
        selection: ScreenCaptureSelection,
        excluded_window: Option<u32>,
        excluded_preview: Option<u32>,
    ) -> Result<(), String> {
        let (filter, dimensions) = if matches!(selection, ScreenCaptureSelection::Window) {
            let windows: *mut AnyObject = msg_send![content, windows];
            let mut selected = None;
            if !windows.is_null() {
                let count: usize = msg_send![windows, count];
                for index in 0..count {
                    let window: *mut AnyObject = msg_send![windows, objectAtIndex: index];
                    if let Some(candidate) = window_source(window, request.host_window_id) {
                        if candidate.id == source.id {
                            selected = Some((window, candidate));
                            break;
                        }
                    }
                }
            }
            let (window, candidate) = selected
                .ok_or("The selected window is no longer available. Choose a window again.")?;
            source = candidate;
            let filter: Option<Retained<AnyObject>> = msg_send![msg_send![sc_class(c"SCContentFilter")?, alloc], initWithDesktopIndependentWindow: window];
            let filter = filter.ok_or("Could not configure the selected window.")?;
            let scale: f32 = msg_send![&*filter, pointPixelScale];
            if !scale.is_finite() || scale <= 0.0 {
                return Err("The selected window has no usable scale.".into());
            }
            let content_rect: NSRect = msg_send![&*filter, contentRect];
            if !content_rect.size.width.is_finite()
                || !content_rect.size.height.is_finite()
                || content_rect.size.width <= 0.0
                || content_rect.size.height <= 0.0
            {
                return Err("The selected window has no usable content bounds.".into());
            }
            let dimensions = bounded_dimensions(
                (content_rect.size.width * scale as f64).ceil() as usize,
                (content_rect.size.height * scale as f64).ceil() as usize,
            )?;
            (filter, dimensions)
        } else {
            let displays: *mut AnyObject = msg_send![content, displays];
            if displays.is_null() {
                return Err("No displays are available for screen sharing.".into());
            }
            let count: usize = msg_send![displays, count];
            let mut selected = std::ptr::null_mut::<AnyObject>();
            for index in 0..count {
                let display: *mut AnyObject = msg_send![displays, objectAtIndex: index];
                let id: u32 = msg_send![display, displayID];
                if id == source.id {
                    selected = display;
                    break;
                }
            }
            if selected.is_null() {
                return Err(
                    "The selected display is no longer available. Choose a display again.".into(),
                );
            }
            // Exclude the mark that was visible when capture began. New marks wait
            // for this capture to finish; the existing mark never needs to blink.
            let mut excluded = Vec::new();
            let mut found_pointer = excluded_window.is_none();
            let mut found_preview = excluded_preview.is_none();
            let mut remaining_frame_windows = request.frame_guard.excluded_windows.clone();
            let windows: *mut AnyObject = msg_send![content, windows];
            if !windows.is_null() {
                let count: usize = msg_send![windows, count];
                for index in 0..count {
                    let window: *mut AnyObject = msg_send![windows, objectAtIndex: index];
                    let id: u32 = msg_send![window, windowID];
                    if super::excluded_capture_window(id, excluded_window, excluded_preview)
                        || request.frame_guard.excluded_windows.contains(&id)
                    {
                        if let Some(window) = Retained::retain(window) {
                            found_pointer |= Some(id) == excluded_window;
                            found_preview |= Some(id) == excluded_preview;
                            remaining_frame_windows.retain(|frame_id| *frame_id != id);
                            excluded.push(window);
                        }
                    }
                }
            }
            if !remaining_frame_windows.is_empty() {
                return Err(
                    "Could not exclude the capture region frame. Stop sharing and try again."
                        .into(),
                );
            }
            if !found_pointer {
                return Err(
                "Could not exclude the screen pointer from capture. Try again after it expires."
                    .into(),
            );
            }
            if !found_preview {
                return Err("Could not exclude the screen preview from capture. Try again.".into());
            }
            let excluded_windows = NSArray::from_retained_slice(&excluded);
            let filter: Option<Retained<AnyObject>> = msg_send![
                msg_send![sc_class(c"SCContentFilter")?, alloc],
                initWithDisplay: selected,
                excludingWindows: &*excluded_windows,
            ];
            let filter =
                filter.ok_or_else(|| "Could not configure the selected display.".to_string())?;
            let bounds = CGDisplayBounds(source.id);
            let dimensions = match &selection {
                ScreenCaptureSelection::Region { region } => {
                    region.validate_display(bounds.size.width, bounds.size.height)?;
                    bounded_dimensions(
                        (region.width * source.width as f64 / region.display_width)
                            .floor()
                            .max(1.0) as usize,
                        (region.height * source.height as f64 / region.display_height)
                            .floor()
                            .max(1.0) as usize,
                    )?
                }
                _ => bounded_dimensions(source.width, source.height)?,
            };
            (filter, dimensions)
        };
        let configuration: Retained<AnyObject> =
            msg_send![sc_class(c"SCStreamConfiguration")?, new];
        if let ScreenCaptureSelection::Region { region } = &selection {
            let crop = NSRect::new(
                NSPoint::new(region.x, region.y),
                NSSize::new(region.width, region.height),
            );
            let _: () = msg_send![&*configuration, setSourceRect: crop];
            source.name = format!("{} — Selected region", source.name);
        }
        if matches!(selection, ScreenCaptureSelection::Window) {
            // Output is exactly the selected window's content bounds, without shadow padding.
            let _: () = msg_send![&*configuration, setIgnoreShadowsSingleWindow: Bool::YES];
            // A window remains the same selected source when partly outside a display.
            let _: () = msg_send![&*configuration, setIgnoreGlobalClipSingleWindow: Bool::YES];
        }
        let _: () = msg_send![&*configuration, setWidth: dimensions.0];
        let _: () = msg_send![&*configuration, setHeight: dimensions.1];
        let _: () = msg_send![&*configuration, setShowsCursor: Bool::YES];
        let _: () = msg_send![&*configuration, setCapturesAudio: Bool::NO];
        let callback = RcBlock::new(move |image: *const c_void, error: *mut AnyObject| {
            autoreleasepool(|_| {
                if request.cancelled.load(Ordering::Acquire) {
                    return;
                }
                if !error.is_null() || image.is_null() {
                    request.complete(Err(capture_error(error)));
                    return;
                }
                // The image is borrowed from ScreenCaptureKit and remains valid
                // for this callback; NSBitmapImageRep retains it during encoding.
                // Do not CGImageRelease the borrowed image.
                let captured_at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let result = if (unsafe { CGImageGetWidth(image) }, unsafe {
                    CGImageGetHeight(image)
                }) != dimensions
                {
                    Err(
                        "Screen capture returned unexpected image dimensions. Start sharing again."
                            .into(),
                    )
                } else {
                    encode_frame(image, &source, captured_at).map(|mut frame| {
                        frame.selection_kind = selection.kind();
                        frame
                    })
                };
                request.complete(result);
            });
        });
        let _: () = msg_send![
            sc_class(c"SCScreenshotManager")?,
            captureImageWithFilter: &*filter,
            configuration: &*configuration,
            completionHandler: &*callback,
        ];
        Ok(())
    }

    fn capture_error(error: *mut AnyObject) -> String {
        if !unsafe { CGPreflightScreenCaptureAccess() } {
            return PERMISSION_DENIED.into();
        }
        if error.is_null() {
            "ScreenCaptureKit returned no image. The selected display may be unavailable.".into()
        } else {
            // Numeric error only: do not copy arbitrary application/window details
            // from an OS error into diagnostics or agent context.
            let code: isize = unsafe { msg_send![error, code] };
            format!("ScreenCaptureKit could not capture the display (error {code}).")
        }
    }

    fn encode_frame(
        image: *const c_void,
        source: &ScreenCaptureSource,
        captured_at: u64,
    ) -> Result<ScreenCaptureFrame, String> {
        unsafe {
            let width = CGImageGetWidth(image);
            let height = CGImageGetHeight(image);
            if width == 0 || height == 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
                return Err("Screen capture returned unexpected image dimensions.".into());
            }
            let bitmap: Option<Retained<NSBitmapImageRep>> =
                msg_send![NSBitmapImageRep::alloc(), initWithCGImage: image];
            let bitmap = bitmap.ok_or_else(|| "Could not encode screen capture.".to_string())?;
            let quality = NSNumber::new_f64(0.9);
            let properties = NSDictionary::from_slices(&[NSImageCompressionFactor], &[&*quality]);
            let data: Option<Retained<NSData>> = msg_send![
                &*bitmap,
                representationUsingType: NSBitmapImageFileType::JPEG,
                properties: &*properties,
            ];
            let data =
                data.ok_or_else(|| "Could not encode screen capture as JPEG.".to_string())?;
            let length: usize = msg_send![&*data, length];
            let bytes: *const u8 = msg_send![&*data, bytes];
            if bytes.is_null() || length == 0 || length > MAX_JPEG_BYTES {
                return Err(
                    "Screen capture exceeded the image size limit or returned an empty image."
                        .into(),
                );
            }
            let data_url = format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD
                    .encode(std::slice::from_raw_parts(bytes, length))
            );
            Ok(ScreenCaptureFrame {
                selection_kind: "display",
                frame_id: String::new(),
                pointers_enabled: false,
                pointer_frame_valid: false,
                pointer_epoch: 0,
                source_id: source.id,
                source_name: source.name.clone(),
                captured_at,
                data_url,
                width,
                height,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_dimensions, oriented_pixel_dimensions, MAX_IMAGE_EDGE};

    #[test]
    fn allows_only_the_authenticated_main_window_from_our_process() {
        let own_pid = std::process::id() as i32;
        assert!(super::shareable_window_owner(own_pid, 42, Some(42)));
        // Preview, controls, selector and pointer windows must all remain excluded.
        for helper_id in [43, 44, 45, 46] {
            assert!(!super::shareable_window_owner(own_pid, helper_id, Some(42)));
        }
        assert!(!super::shareable_window_owner(own_pid, 42, None));
        assert!(!super::shareable_window_owner(own_pid, 0, Some(0)));
        // A replaced main window must not authorize its old native ID.
        assert!(!super::shareable_window_owner(own_pid, 42, Some(50)));
        assert!(super::shareable_window_owner(own_pid + 1, 99, Some(42)));
        assert!(super::shareable_window_owner(own_pid + 1, 99, None));
    }

    #[test]
    fn uses_retina_backing_detail_instead_of_upscaling_logical_pixels() {
        let pixels = oriented_pixel_dimensions((2940, 1912), (1470.0, 956.0)).unwrap();
        assert_eq!(pixels, (2940, 1912));
        assert_eq!(
            bounded_dimensions(pixels.0, pixels.1).unwrap(),
            (2560, 1664)
        );
        let native = oriented_pixel_dimensions((1920, 1080), (1920.0, 1080.0)).unwrap();
        assert_eq!(bounded_dimensions(native.0, native.1).unwrap(), native);
    }

    #[test]
    fn respects_portrait_bounds_without_double_rotating_a_mode() {
        for pixels in [(2940, 1912), (1912, 2940)] {
            let oriented = oriented_pixel_dimensions(pixels, (956.0, 1470.0)).unwrap();
            assert_eq!(oriented, (1912, 2940));
            assert_eq!(
                bounded_dimensions(oriented.0, oriented.1).unwrap(),
                (1664, 2560)
            );
        }
    }

    #[test]
    fn rejects_inconsistent_or_unusable_display_modes() {
        assert!(oriented_pixel_dimensions((1920, 1080), (1470.0, 956.0)).is_err());
        assert!(oriented_pixel_dimensions((0, 1080), (1920.0, 1080.0)).is_err());
        for bounds in [(0.0, 1080.0), (1920.0, -1.0), (f64::NAN, 1080.0)] {
            assert!(oriented_pixel_dimensions((1920, 1080), bounds).is_err());
        }
    }

    #[test]
    fn bounds_retina_and_portrait_images_without_upscaling() {
        assert_eq!(bounded_dimensions(5120, 2880).unwrap(), (2560, 1440));
        assert_eq!(bounded_dimensions(2880, 5120).unwrap(), (1440, 2560));
        assert_eq!(bounded_dimensions(640, 480).unwrap(), (640, 480));
        assert_eq!(
            bounded_dimensions(1, usize::MAX).unwrap(),
            (1, MAX_IMAGE_EDGE)
        );
    }

    #[test]
    fn rejects_disconnected_display_dimensions() {
        assert!(bounded_dimensions(0, 1080).is_err());
        assert!(bounded_dimensions(1920, 0).is_err());
    }
}
