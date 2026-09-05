//! Host-owned references to the explicitly shared display. These marks describe
//! what the resident is talking about; they are not model attention telemetry.
//!
//! Only the main window can grant/revoke a sharing lease. MCP receives opaque
//! frame IDs through the existing image transport, never authority to start
//! capture. All state changes and native drawing run on the AppKit main thread.

use std::collections::VecDeque;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::schemars;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

#[cfg(target_os = "macos")]
mod macos;

const FRAME_MAX_AGE: Duration = Duration::from_secs(120);
const FRAME_LIMIT: usize = 4;
const DEFAULT_DURATION_MS: u64 = 8_000;
const MAX_DURATION_MS: u64 = 15_000;
// screen_capture::macos::capture bounds its OS callback at 15 seconds. Allow
// that existing capture to finish plus its UI-thread handoff, without forcing
// the model to make a second call merely because capture took a few seconds.
const POINTER_CAPTURE_WAIT: Duration = Duration::from_secs(16);
const POINTER_WAIT_EXPIRED: &str =
    "The screen capture did not finish in time. Inspect a fresh shared image before pointing.";
#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "Screen pointers require macOS 14 or later.";

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct DisplayGeometry {
    pub source_id: u32,
    /// CoreGraphics global logical points, top-left of the main display.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub pixel_width: usize,
    pub pixel_height: usize,
    pub main_height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum AnnotationTarget {
    Arrow {
        x: f64,
        y: f64,
    },
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScreenPointerKind {
    Arrow,
    Rect,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenPointerRequest {
    /// Opaque frameId supplied with the shared-screen image you inspected.
    pub frame_id: String,
    pub kind: ScreenPointerKind,
    /// Normalized image coordinate: 0 is left, 1 is right. Arrow tip or rect left.
    pub x: f64,
    /// Normalized image coordinate: 0 is top, 1 is bottom. Arrow tip or rect top.
    pub y: f64,
    /// Required for rect: positive normalized width, contained in the image.
    pub width: Option<f64>,
    /// Required for rect: positive normalized height, contained in the image.
    pub height: Option<f64>,
    /// Optional single-line label, at most 80 characters. Plain text only.
    pub label: Option<String>,
    /// Visible lifetime, 500–15000 milliseconds. Defaults to 8000.
    pub duration_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPointerResult {
    status: &'static str,
    frame_id: String,
    duration_ms: u64,
}

impl ScreenPointerRequest {
    fn resolve(&self, geometry: DisplayGeometry) -> Result<(AnnotationTarget, u64), String> {
        let unit = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
        if !unit(self.x) || !unit(self.y) {
            return Err("x and y must be finite normalized image coordinates from 0 to 1.".into());
        }
        if self
            .label
            .as_ref()
            .is_some_and(|label| label.chars().count() > 80 || label.chars().any(char::is_control))
        {
            return Err("Use a single-line label of at most 80 characters.".into());
        }
        let duration = self.duration_ms.unwrap_or(DEFAULT_DURATION_MS);
        if !(500..=MAX_DURATION_MS).contains(&duration) {
            return Err("durationMs must be between 500 and 15000.".into());
        }
        let x = self.x * geometry.width;
        let y = self.y * geometry.height;
        let target = match self.kind {
            ScreenPointerKind::Arrow => {
                if self.width.is_some() || self.height.is_some() {
                    return Err("An arrow uses only x and y; omit width and height.".into());
                }
                AnnotationTarget::Arrow { x, y }
            }
            ScreenPointerKind::Rect => {
                let (Some(width), Some(height)) = (self.width, self.height) else {
                    return Err("A rect requires width and height.".into());
                };
                if !unit(width)
                    || !unit(height)
                    || width <= 0.0
                    || height <= 0.0
                    || self.x + width > 1.0 + f64::EPSILON
                    || self.y + height > 1.0 + f64::EPSILON
                {
                    return Err(
                        "The rect must have positive dimensions and fit inside the image.".into(),
                    );
                }
                AnnotationTarget::Rect {
                    x,
                    y,
                    width: width * geometry.width,
                    height: height * geometry.height,
                }
            }
        };
        Ok((target, duration))
    }
}

struct FrameAnchor {
    id: String,
    fingerprint: u64,
    width: usize,
    height: usize,
    observed_at: Instant,
}

struct SharingLease {
    id: String,
    geometry: DisplayGeometry,
    frames: VecDeque<FrameAnchor>,
    capturing: bool,
}

#[derive(Clone)]
struct VisibleAnnotation {
    generation: u64,
    geometry: DisplayGeometry,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    target: AnnotationTarget,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    label: Option<String>,
    expires_at: Instant,
}

struct AnnotationState {
    document_id: String,
    lease: Option<SharingLease>,
    visible: Option<VisibleAnnotation>,
    generation: u64,
    changes: watch::Sender<u64>,
}

impl Default for AnnotationState {
    fn default() -> Self {
        Self {
            document_id: uuid::Uuid::new_v4().to_string(),
            lease: None,
            visible: None,
            generation: 0,
            changes: watch::channel(0).0,
        }
    }
}

impl AnnotationState {
    fn begin_for_document(
        &mut self,
        document_id: &str,
        id: String,
        geometry: DisplayGeometry,
    ) -> Result<(), String> {
        if self.document_id != document_id {
            return Err(
                "The application reloaded. Start screen sharing from the current window.".into(),
            );
        }
        self.begin(id, geometry);
        Ok(())
    }

    fn reload(&mut self) {
        self.document_id = uuid::Uuid::new_v4().to_string();
        self.lease = None;
        self.clear();
    }

    fn begin(&mut self, id: String, geometry: DisplayGeometry) {
        self.clear();
        self.lease = Some(SharingLease {
            id,
            geometry,
            frames: VecDeque::new(),
            capturing: false,
        });
    }

    fn clear(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.visible = None;
        self.changed();
    }

    fn changed(&self) {
        self.changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    fn expire_visible(&mut self, generation: u64) {
        if self
            .visible
            .as_ref()
            .is_some_and(|mark| mark.generation == generation)
        {
            self.visible = None;
            // Natural expiry of an older mark must not cancel a newer request
            // waiting for capture. User clear/stop always advance generation.
            if self.generation == generation {
                self.generation = self.generation.wrapping_add(1);
            }
            self.changed();
        }
    }

    fn finish_capture(&mut self, share_id: &str) -> bool {
        let Some(lease) = self.lease.as_mut().filter(|lease| lease.id == share_id) else {
            return false;
        };
        lease.capturing = false;
        self.changed();
        true
    }

    fn end(&mut self, id: &str) -> bool {
        if self.lease.as_ref().is_some_and(|lease| lease.id == id) {
            self.lease = None;
            self.clear();
            true
        } else {
            false
        }
    }

    fn lease(&mut self, id: &str, geometry: DisplayGeometry) -> Result<&mut SharingLease, String> {
        let current = self.lease.as_ref().ok_or("Screen sharing is stopped.")?;
        if current.id != id {
            return Err("This screen sharing lease has ended.".into());
        }
        if current.geometry != geometry {
            self.end(id);
            return Err("The shared display changed. Start sharing again before pointing.".into());
        }
        self.lease
            .as_mut()
            .ok_or_else(|| "Screen sharing is stopped.".into())
    }

    fn register(
        &mut self,
        id: &str,
        geometry: DisplayGeometry,
        fingerprint: u64,
        width: usize,
        height: usize,
        now: Instant,
    ) -> Result<String, String> {
        let lease = self.lease(id, geometry)?;
        lease
            .frames
            .retain(|frame| now.duration_since(frame.observed_at) <= FRAME_MAX_AGE);
        // Identical captures are deduplicated by the frontend. Keep the token of
        // that actual delivered image valid while the same pixels are observed.
        if let Some(index) = lease.frames.iter().position(|frame| {
            frame.fingerprint == fingerprint && frame.width == width && frame.height == height
        }) {
            let mut frame = lease.frames.remove(index).expect("existing frame index");
            frame.observed_at = now;
            let frame_id = frame.id.clone();
            lease.frames.push_back(frame);
            return Ok(frame_id);
        }
        let frame_id = uuid::Uuid::new_v4().to_string();
        lease.frames.push_back(FrameAnchor {
            id: frame_id.clone(),
            fingerprint,
            width,
            height,
            observed_at: now,
        });
        while lease.frames.len() > FRAME_LIMIT {
            lease.frames.pop_front();
        }
        Ok(frame_id)
    }

    fn frame_geometry(&self, id: &str, now: Instant) -> Result<DisplayGeometry, String> {
        let lease = self
            .lease
            .as_ref()
            .ok_or("Screen sharing is stopped. Ask the user to start sharing.")?;
        let frame = lease.frames.iter().find(|frame| frame.id == id).ok_or(
            "This frame is no longer available. Inspect a recent shared-screen image first.",
        )?;
        if now.duration_since(frame.observed_at) > FRAME_MAX_AGE {
            return Err(
                "This shared-screen image is too old. Wait for a fresh shared image.".into(),
            );
        }
        Ok(lease.geometry)
    }

    fn reserve_show(
        &mut self,
        request: Arc<ScreenPointerRequest>,
        now: Instant,
    ) -> Result<PendingShow, String> {
        let geometry = self.frame_geometry(&request.frame_id, now)?;
        request.resolve(geometry)?;
        let share_id = self
            .lease
            .as_ref()
            .ok_or("Screen sharing is stopped.")?
            .id
            .clone();
        self.generation = self.generation.wrapping_add(1);
        self.changed();
        Ok(PendingShow {
            request,
            share_id,
            document_id: self.document_id.clone(),
            geometry,
            generation: self.generation,
        })
    }

    fn pending_geometry(
        &self,
        pending: &PendingShow,
        now: Instant,
    ) -> Result<(DisplayGeometry, bool), String> {
        if self.document_id != pending.document_id || self.generation != pending.generation {
            return Err("This pointer request was cleared or superseded.".into());
        }
        let lease = self
            .lease
            .as_ref()
            .filter(|lease| lease.id == pending.share_id)
            .ok_or("This screen sharing lease has ended.")?;
        let geometry = self.frame_geometry(&pending.request.frame_id, now)?;
        if geometry != pending.geometry {
            return Err("The shared display changed. Start sharing again before pointing.".into());
        }
        Ok((geometry, lease.capturing))
    }

    fn should_hide(
        &self,
        generation: u64,
        now: Instant,
        geometry: Option<DisplayGeometry>,
    ) -> bool {
        self.visible.as_ref().is_some_and(|mark| {
            mark.generation == generation
                && (now >= mark.expires_at || geometry != Some(mark.geometry))
        })
    }
}

#[derive(Clone)]
struct PendingShow {
    request: Arc<ScreenPointerRequest>,
    share_id: String,
    document_id: String,
    geometry: DisplayGeometry,
    generation: u64,
}

struct ShowLifetime {
    cancelled: AtomicBool,
    deadline: Instant,
}

impl ShowLifetime {
    fn check(&self, now: Instant) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("The screen pointer request was cancelled.".into());
        }
        if now >= self.deadline {
            return Err(POINTER_WAIT_EXPIRED.into());
        }
        Ok(())
    }
}

struct CancelShowOnDrop(Arc<ShowLifetime>);

impl Drop for CancelShowOnDrop {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

#[derive(Default)]
pub struct ScreenAnnotationState(Mutex<AnnotationState>);

fn require_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the main application window controls screen sharing.".into())
    }
}

async fn on_main<R: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(&AppHandle) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    let handle = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(action(&handle));
    })
    .map_err(|_| "Could not update the screen pointer.".to_string())?;
    receiver
        .await
        .map_err(|_| "Screen pointer update was cancelled.".to_string())?
}

fn display_geometry(source_id: u32) -> Result<DisplayGeometry, String> {
    #[cfg(target_os = "macos")]
    return macos::display_geometry(source_id);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_id;
        Err(UNSUPPORTED.into())
    }
}

fn hide() {
    #[cfg(target_os = "macos")]
    macos::hide();
}

fn draw(mark: &VisibleAnnotation) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::show(mark.geometry, mark.target, mark.label.as_deref());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = mark;
        Err(UNSUPPORTED.into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn window_id() -> Option<u32> {
    macos::window_id()
}

#[tauri::command]
pub fn screen_annotation_document(window: tauri::WebviewWindow) -> Result<String, String> {
    require_host(&window)?;
    let managed = window.state::<ScreenAnnotationState>();
    let state = managed
        .0
        .lock()
        .map_err(|_| "Screen pointer state is unavailable.")?;
    Ok(state.document_id.clone())
}

/// Page reload destroys the JS owner without destroying the native main window.
/// Rotate its authority synchronously so an old, queued begin cannot re-grant it.
pub fn document_reloaded(app: &AppHandle) {
    if let Some(managed) = app.try_state::<ScreenAnnotationState>() {
        if let Ok(mut state) = managed.0.lock() {
            state.reload();
        }
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(managed) = handle.try_state::<ScreenAnnotationState>() {
            if let Ok(state) = managed.0.lock() {
                // Do not erase a new mark if this UI-thread callback was delayed.
                if state.visible.is_none() {
                    hide();
                }
            }
        }
    });
}

#[tauri::command]
pub async fn screen_annotation_begin(
    window: tauri::WebviewWindow,
    share_id: String,
    source_id: u32,
    document_id: String,
) -> Result<(), String> {
    require_host(&window)?;
    if uuid::Uuid::parse_str(&share_id).is_err() {
        return Err("Invalid screen sharing lease.".into());
    }
    on_main(window.app_handle(), move |app| {
        let geometry = display_geometry(source_id)?;
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        state.begin_for_document(&document_id, share_id, geometry)?;
        hide();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn screen_annotation_end(
    window: tauri::WebviewWindow,
    share_id: String,
) -> Result<(), String> {
    require_host(&window)?;
    on_main(window.app_handle(), move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        if state.end(&share_id) {
            hide();
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn screen_annotation_clear(window: tauri::WebviewWindow) -> Result<(), String> {
    require_host(&window)?;
    clear(window.app_handle()).await
}

pub async fn clear(app: &AppHandle) -> Result<(), String> {
    on_main(app, move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        state.clear();
        hide();
        Ok(())
    })
    .await
}

/// Called from the application's main-thread window/exit event handlers.
pub fn shutdown(app: &AppHandle) {
    let managed = app.state::<ScreenAnnotationState>();
    if let Ok(mut state) = managed.0.lock() {
        state.lease = None;
        state.clear();
    }
    hide();
}

pub async fn show(
    app: &AppHandle,
    request: ScreenPointerRequest,
) -> Result<ScreenPointerResult, String> {
    let lifetime = Arc::new(ShowLifetime {
        cancelled: AtomicBool::new(false),
        deadline: Instant::now() + POINTER_CAPTURE_WAIT,
    });
    // Dropping this future (including timeout) also disarms a callback that was
    // already queued on the UI thread. It cannot draw a late, abandoned request.
    let _cancel = CancelShowOnDrop(lifetime.clone());
    let deadline = tokio::time::Instant::from_std(lifetime.deadline);
    let work = async {
        let initial_lifetime = lifetime.clone();
        let (pending, mut changes, shown) = on_main(app, move |app| {
            initial_lifetime.check(Instant::now())?;
            let managed = app.state::<ScreenAnnotationState>();
            let mut state = managed
                .0
                .lock()
                .map_err(|_| "Screen pointer state is unavailable.")?;
            let pending = state.reserve_show(Arc::new(request), Instant::now())?;
            // Subscribe while holding the same lock as the capture check, so a
            // completion before the async waiter starts cannot be missed.
            let changes = state.changes.subscribe();
            let shown = try_show(app, &mut state, &pending, &initial_lifetime)?;
            Ok((pending, changes, shown))
        })
        .await?;
        if let Some(result) = shown {
            return Ok(result);
        }
        loop {
            // Wait in Tokio, never in AppKit and never with the state locked.
            changes
                .changed()
                .await
                .map_err(|_| "Screen pointer state was closed.".to_string())?;
            let next = pending.clone();
            let next_lifetime = lifetime.clone();
            let shown = on_main(app, move |app| {
                let managed = app.state::<ScreenAnnotationState>();
                let mut state = managed
                    .0
                    .lock()
                    .map_err(|_| "Screen pointer state is unavailable.")?;
                try_show(app, &mut state, &next, &next_lifetime)
            })
            .await?;
            if let Some(result) = shown {
                return Ok(result);
            }
        }
    };
    tokio::time::timeout_at(deadline, work)
        .await
        .map_err(|_| POINTER_WAIT_EXPIRED.to_string())?
}

fn try_show(
    app: &AppHandle,
    state: &mut AnnotationState,
    pending: &PendingShow,
    lifetime: &ShowLifetime,
) -> Result<Option<ScreenPointerResult>, String> {
    let now = Instant::now();
    lifetime.check(now)?;
    let (geometry, capturing) = state.pending_geometry(pending, now)?;
    if display_geometry(geometry.source_id).ok() != Some(geometry) {
        state.lease = None;
        state.clear();
        hide();
        return Err("The shared display changed. Start sharing again before pointing.".into());
    }
    if capturing {
        return Ok(None);
    }
    let (target, duration_ms) = pending.request.resolve(geometry)?;
    lifetime.check(Instant::now())?;
    let mark = VisibleAnnotation {
        generation: pending.generation,
        geometry,
        target,
        label: pending.request.label.clone(),
        // The requested visible lifetime starts when the mark can be drawn,
        // rather than being consumed while a capture is still in flight.
        expires_at: Instant::now() + Duration::from_millis(duration_ms),
    };
    draw(&mark)?;
    state.visible = Some(mark);
    // Start cleanup from the UI action, even if the MCP caller disconnects
    // immediately after drawing and never receives its result.
    start_watchdog(app, pending.generation);
    Ok(Some(ScreenPointerResult {
        status: "shown",
        frame_id: pending.request.frame_id.clone(),
        duration_ms,
    }))
}

fn start_watchdog(app: &AppHandle, generation: u64) {
    let handle = app.clone();
    // Each replacement invalidates the old watchdog, so its expiry cannot hide
    // a newer mark. Also clear within 250 ms of disconnect/reconfiguration.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let keep = on_main(&handle, move |app| {
                let managed = app.state::<ScreenAnnotationState>();
                let mut state = managed
                    .0
                    .lock()
                    .map_err(|_| "Screen pointer state is unavailable.")?;
                let Some(mark) = state.visible.as_ref() else {
                    return Ok(false);
                };
                if mark.generation != generation {
                    return Ok(false);
                }
                let geometry = display_geometry(mark.geometry.source_id).ok();
                if state.should_hide(generation, Instant::now(), geometry) {
                    if geometry != state.lease.as_ref().map(|lease| lease.geometry) {
                        state.lease = None;
                        state.clear();
                    } else {
                        state.expire_visible(generation);
                    }
                    hide();
                    return Ok(false);
                }
                Ok(true)
            })
            .await;
            if keep != Ok(true) {
                break;
            }
        }
    });
}

/// Hide annotations throughout capture, so a new/replaced window cannot sneak
/// into a ScreenCaptureKit filter that was already constructed. Show requests
/// await a bounded completion notification and only acknowledge an actual draw.
pub struct CaptureGuard {
    app: AppHandle,
    share_id: String,
    geometry: DisplayGeometry,
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        let app = self.app.clone();
        let share_id = self.share_id.clone();
        let _ = self.app.run_on_main_thread(move || {
            let managed = app.state::<ScreenAnnotationState>();
            let Ok(mut state) = managed.0.lock() else {
                return;
            };
            if !state.finish_capture(&share_id) {
                return;
            }
            if let Some(mark) = state.visible.as_ref() {
                let generation = mark.generation;
                let geometry_matches =
                    display_geometry(mark.geometry.source_id).ok() == Some(mark.geometry);
                if Instant::now() < mark.expires_at && geometry_matches && draw(mark).is_ok() {
                    return;
                }
                if geometry_matches {
                    state.expire_visible(generation);
                } else {
                    state.lease = None;
                    state.clear();
                }
                hide();
            }
        });
    }
}

pub async fn begin_capture(
    app: &AppHandle,
    share_id: String,
    source_id: u32,
) -> Result<CaptureGuard, String> {
    let id = share_id.clone();
    let geometry = on_main(app, move |app| {
        let geometry = display_geometry(source_id)?;
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        let lease = match state.lease(&id, geometry) {
            Ok(lease) => lease,
            Err(error) => {
                if state.lease.is_none() {
                    hide();
                }
                return Err(error);
            }
        };
        if lease.capturing {
            return Err("A screen capture is already in progress.".into());
        }
        lease.capturing = true;
        state.changed();
        hide();
        Ok(geometry)
    })
    .await?;
    Ok(CaptureGuard {
        app: app.clone(),
        share_id,
        geometry,
    })
}

pub async fn register_frame(
    guard: &CaptureGuard,
    frame: &crate::screen_capture::ScreenCaptureFrame,
) -> Result<String, String> {
    if frame.source_id != guard.geometry.source_id || frame.width == 0 || frame.height == 0 {
        return Err("Screen capture does not match the shared display.".into());
    }
    if (frame.width, frame.height)
        != crate::screen_capture::bounded_dimensions(
            guard.geometry.pixel_width,
            guard.geometry.pixel_height,
        )?
    {
        return Err("Screen capture dimensions changed. Start sharing again.".into());
    }
    let mut hasher = DefaultHasher::new();
    frame.data_url.hash(&mut hasher);
    let fingerprint = hasher.finish();
    let width = frame.width;
    let height = frame.height;
    let id = guard.share_id.clone();
    let geometry = guard.geometry;
    on_main(&guard.app, move |app| {
        let managed = app.state::<ScreenAnnotationState>();
        let mut state = managed
            .0
            .lock()
            .map_err(|_| "Screen pointer state is unavailable.")?;
        if display_geometry(geometry.source_id).ok() != Some(geometry) {
            if state.end(&id) {
                hide();
            }
            return Err("The display changed while capturing. Start sharing again.".into());
        }
        state.register(&id, geometry, fingerprint, width, height, Instant::now())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry() -> DisplayGeometry {
        DisplayGeometry {
            source_id: 1,
            x: -1920.0,
            y: -120.0,
            width: 1920.0,
            height: 1080.0,
            pixel_width: 3840,
            pixel_height: 2160,
            main_height: 900.0,
        }
    }

    fn request(kind: ScreenPointerKind, x: f64, y: f64) -> ScreenPointerRequest {
        ScreenPointerRequest {
            frame_id: "frame".into(),
            kind,
            x,
            y,
            width: None,
            height: None,
            label: None,
            duration_ms: None,
        }
    }

    #[test]
    fn normalized_image_coordinates_map_to_retina_display_points_not_global_or_image_pixels() {
        let g = geometry();
        assert_eq!(
            request(ScreenPointerKind::Arrow, 0.25, 0.75)
                .resolve(g)
                .unwrap()
                .0,
            AnnotationTarget::Arrow { x: 480.0, y: 810.0 }
        );
        let mut rect = request(ScreenPointerKind::Rect, 0.75, 0.5);
        rect.width = Some(0.25);
        rect.height = Some(0.5);
        assert_eq!(
            rect.resolve(g).unwrap().0,
            AnnotationTarget::Rect {
                x: 1440.0,
                y: 540.0,
                width: 480.0,
                height: 540.0
            }
        );
        let portrait = DisplayGeometry {
            width: 900.0,
            height: 1600.0,
            ..g
        };
        assert_eq!(
            request(ScreenPointerKind::Arrow, 1.0, 0.0)
                .resolve(portrait)
                .unwrap()
                .0,
            AnnotationTarget::Arrow { x: 900.0, y: 0.0 }
        );
    }

    #[test]
    fn malformed_coordinates_labels_and_unbounded_lifetimes_are_rejected() {
        for x in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
            assert!(request(ScreenPointerKind::Arrow, x, 0.5)
                .resolve(geometry())
                .is_err());
        }
        let mut rect = request(ScreenPointerKind::Rect, 0.8, 0.5);
        assert!(rect.resolve(geometry()).is_err());
        rect.width = Some(0.3);
        rect.height = Some(0.2);
        assert!(rect.resolve(geometry()).is_err());
        rect.width = Some(0.0);
        assert!(rect.resolve(geometry()).is_err());
        let mut arrow = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        arrow.duration_ms = Some(15_001);
        assert!(arrow.resolve(geometry()).is_err());
        arrow.duration_ms = None;
        arrow.label = Some("two\nlines".into());
        assert!(arrow.resolve(geometry()).is_err());
    }

    #[test]
    fn stop_and_source_change_revoke_old_tokens_and_late_stops_preserve_new_lease() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("first".into(), geometry());
        let frame = state
            .register("first", geometry(), 1, 2560, 1440, now)
            .unwrap();
        assert!(state.frame_geometry(&frame, now).is_ok());
        state.end("first");
        assert!(state.frame_geometry(&frame, now).is_err());
        state.begin("second".into(), geometry());
        assert!(!state.end("first"));
        assert!(state
            .register("first", geometry(), 2, 2560, 1440, now)
            .is_err());
        let next = state
            .register("second", geometry(), 3, 2560, 1440, now)
            .unwrap();
        assert!(state.frame_geometry(&next, now).is_ok());
        let moved = DisplayGeometry {
            x: 0.0,
            ..geometry()
        };
        assert!(state.register("second", moved, 3, 2560, 1440, now).is_err());
        assert!(state.frame_geometry(&next, now).is_err());
    }

    #[test]
    fn document_reload_revokes_frames_and_rejects_a_late_old_begin() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        let old_document = state.document_id.clone();
        state
            .begin_for_document(&old_document, "old".into(), geometry())
            .unwrap();
        let frame = state
            .register("old", geometry(), 1, 2560, 1440, now)
            .unwrap();
        state.reload();
        assert!(state.frame_geometry(&frame, now).is_err());
        assert!(state
            .begin_for_document(&old_document, "late".into(), geometry())
            .is_err());
        let current_document = state.document_id.clone();
        state
            .begin_for_document(&current_document, "current".into(), geometry())
            .unwrap();
        assert!(!state.end("old"));
        assert_eq!(state.lease.as_ref().unwrap().id, "current");
    }

    #[test]
    fn unchanged_pixels_keep_delivered_token_valid_without_retaining_pixels() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let frame = state
            .register("lease", geometry(), 7, 2560, 1440, now)
            .unwrap();
        for seconds in [5, 30, 60, 90, 120, 150] {
            assert_eq!(
                state
                    .register(
                        "lease",
                        geometry(),
                        7,
                        2560,
                        1440,
                        now + Duration::from_secs(seconds)
                    )
                    .unwrap(),
                frame
            );
        }
        assert_eq!(state.lease.as_ref().unwrap().frames.len(), 1);
        assert!(state
            .frame_geometry(&frame, now + Duration::from_secs(151))
            .is_ok());
        assert!(state
            .frame_geometry(&frame, now + Duration::from_secs(271))
            .is_err());
    }

    #[test]
    fn captures_are_bounded_and_pointer_requests_wait_during_capture() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let first = state
            .register("lease", geometry(), 1, 2560, 1440, now)
            .unwrap();
        for fingerprint in 2..=5 {
            state
                .register("lease", geometry(), fingerprint, 2560, 1440, now)
                .unwrap();
        }
        assert_eq!(state.lease.as_ref().unwrap().frames.len(), FRAME_LIMIT);
        assert!(state.frame_geometry(&first, now).is_err());
        let latest = state
            .lease
            .as_ref()
            .unwrap()
            .frames
            .back()
            .unwrap()
            .id
            .clone();
        state.lease.as_mut().unwrap().capturing = true;
        let mut request = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        request.frame_id = latest;
        let pending = state.reserve_show(Arc::new(request), now).unwrap();
        assert_eq!(
            state.pending_geometry(&pending, now).unwrap(),
            (geometry(), true)
        );
        assert!(state.visible.is_none());
        assert!(state.finish_capture("lease"));
        assert_eq!(
            state.pending_geometry(&pending, now).unwrap(),
            (geometry(), false)
        );
    }

    fn waiting_pointer(now: Instant) -> (AnnotationState, PendingShow) {
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        let frame = state
            .register("lease", geometry(), 1, 2560, 1440, now)
            .unwrap();
        state.lease.as_mut().unwrap().capturing = true;
        let mut request = request(ScreenPointerKind::Arrow, 0.5, 0.5);
        request.frame_id = frame;
        let pending = state.reserve_show(Arc::new(request), now).unwrap();
        (state, pending)
    }

    #[tokio::test]
    async fn capture_completion_before_await_is_not_lost_and_old_lease_cannot_release_wait() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let mut changes = state.changes.subscribe();
        assert!(!state.finish_capture("old-lease"));
        assert!(!changes.has_changed().unwrap());
        assert!(state.finish_capture("lease"));
        tokio::time::timeout(Duration::from_millis(100), changes.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(!state.pending_geometry(&pending, now).unwrap().1);
    }

    #[test]
    fn clear_stop_reload_and_replacement_cancel_waiting_requests() {
        let now = Instant::now();
        for operation in 0..5 {
            let (mut state, pending) = waiting_pointer(now);
            let changes = state.changes.subscribe();
            match operation {
                0 => state.clear(),
                1 => {
                    state.end("lease");
                }
                2 => state.reload(),
                3 => state.begin("replacement-lease".into(), geometry()),
                _ => {
                    let replacement = state.reserve_show(pending.request.clone(), now).unwrap();
                    assert!(state.pending_geometry(&replacement, now).is_ok());
                }
            }
            assert!(changes.has_changed().unwrap());
            assert!(state.pending_geometry(&pending, now).is_err());
        }
    }

    #[test]
    fn pending_request_revalidates_frame_age_eviction_and_display_geometry() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        assert!(state
            .pending_geometry(&pending, now + FRAME_MAX_AGE + Duration::from_millis(1))
            .is_err());
        state.lease.as_mut().unwrap().geometry.x += 1.0;
        assert!(state.pending_geometry(&pending, now).is_err());
        state.lease.as_mut().unwrap().geometry = geometry();
        for fingerprint in 2..=5 {
            state
                .register("lease", geometry(), fingerprint, 2560, 1440, now)
                .unwrap();
        }
        assert!(state.pending_geometry(&pending, now).is_err());
    }

    #[test]
    fn older_mark_expiry_does_not_cancel_a_newer_waiting_request() {
        let now = Instant::now();
        let (mut state, pending) = waiting_pointer(now);
        let old_generation = pending.generation.wrapping_sub(1);
        state.visible = Some(VisibleAnnotation {
            generation: old_generation,
            geometry: geometry(),
            target: AnnotationTarget::Arrow { x: 1.0, y: 2.0 },
            label: None,
            expires_at: now,
        });
        state.expire_visible(old_generation);
        assert!(state.visible.is_none());
        assert!(state.pending_geometry(&pending, now).is_ok());
        state.clear();
        assert!(state.pending_geometry(&pending, now).is_err());
    }

    #[test]
    fn timeout_and_caller_cancellation_disarm_queued_ui_actions() {
        let now = Instant::now();
        let lifetime = Arc::new(ShowLifetime {
            cancelled: AtomicBool::new(false),
            deadline: now + POINTER_CAPTURE_WAIT,
        });
        assert!(lifetime.check(now).is_ok());
        assert!(lifetime.check(now + Duration::from_secs(3)).is_ok());
        assert!(lifetime.check(now + POINTER_CAPTURE_WAIT).is_err());
        let queued_callback_lifetime = lifetime.clone();
        drop(CancelShowOnDrop(lifetime));
        assert!(queued_callback_lifetime.check(now).is_err());
    }

    #[test]
    fn expiry_clear_and_geometry_watchdog_do_not_hide_newer_marks() {
        let now = Instant::now();
        let mut state = AnnotationState::default();
        state.begin("lease".into(), geometry());
        state.visible = Some(VisibleAnnotation {
            generation: 2,
            geometry: geometry(),
            target: AnnotationTarget::Arrow { x: 10.0, y: 20.0 },
            label: None,
            expires_at: now + Duration::from_secs(8),
        });
        assert!(!state.should_hide(1, now + Duration::from_secs(10), Some(geometry())));
        assert!(!state.should_hide(2, now, Some(geometry())));
        assert!(state.should_hide(2, now + Duration::from_secs(8), Some(geometry())));
        assert!(state.should_hide(2, now, None));
        state.clear();
        assert!(state.visible.is_none());
        assert!(state.lease.is_some());
    }
}
