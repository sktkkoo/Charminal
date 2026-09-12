//! A presentation-only remote resident. The main window owns the call and all audio.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN: &str = "main";
const REMOTE: &str = "auxiliary-call-resident";
const QUERY: &str = "auxiliary=call-resident";
const EVENT: &str = "remote-call-window-state";
const ACTION: &str = "remote-call-window-action";
const MAX_AVATAR_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResidentCamera {
    position: [f64; 3],
    quaternion: [f64; 4],
    fov: f64,
    #[serde(default = "default_zoom")]
    zoom: f64,
    near: f64,
    far: f64,
    anchor_y: f64,
}
fn default_zoom() -> f64 {
    1.0
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResidentFrame {
    lease_id: String,
    label: String,
    language: String,
    mode: String,
    /// Existing fixed-size, validated motion format. Never code or arbitrary expression names.
    motion: Option<Vec<u8>>,
    mouth: [f64; 5],
    camera: ResidentCamera,
    #[serde(default)]
    sequence: u64,
    #[serde(default)]
    avatar_revision: u64,
}
impl ResidentFrame {
    fn validate(&self) -> Result<(), String> {
        if self.label.is_empty()
            || self.label.len() > 240
            || self.label.chars().any(char::is_control)
            || !matches!(self.language.as_str(), "ja" | "en")
            || !matches!(self.mode.as_str(), "call" | "portrait")
            || self.motion.as_ref().is_some_and(|bytes| bytes.len() != 505)
            || self
                .mouth
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
            || self
                .camera
                .position
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 100.0)
            || self
                .camera
                .quaternion
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 1.0)
            || (self.camera.quaternion.iter().map(|v| v * v).sum::<f64>() - 1.0).abs() > 0.01
            || !self.camera.fov.is_finite()
            || !self.camera.zoom.is_finite()
            || !(0.001..=100.0).contains(&self.camera.zoom)
            || !(1.0..=179.0).contains(&self.camera.fov)
            || !self.camera.near.is_finite()
            || !(0.001..=10.0).contains(&self.camera.near)
            || !self.camera.far.is_finite()
            || !(self.camera.near..=1000.0).contains(&self.camera.far)
            || !self.camera.anchor_y.is_finite()
            || self.camera.anchor_y.abs() > 10.0
        {
            return Err("Invalid remote resident frame".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct ResidentState {
    lease: Option<String>,
    frame: Option<ResidentFrame>,
    avatar: Option<Vec<u8>>,
    avatar_revision: u64,
    sequence: u64,
    opening: bool,
    closing: bool,
    mode_resize_until: Option<Instant>,
    projected_size: Option<tauri::PhysicalSize<u32>>,
}
impl ResidentState {
    fn require_lease(&self, lease: &str) -> Result<(), String> {
        if self.lease.as_deref() == Some(lease) {
            Ok(())
        } else {
            Err("Remote resident view is no longer active".into())
        }
    }
    fn clear(&mut self) -> Option<String> {
        self.frame = None;
        self.avatar = None;
        self.avatar_revision = 0;
        self.mode_resize_until = None;
        self.projected_size = None;
        self.lease.take()
    }
    fn begin_mode_resize(&mut self, size: tauri::PhysicalSize<u32>, now: Instant) {
        self.mode_resize_until = Some(now + Duration::from_secs(1));
        self.projected_size = Some(size);
    }
    fn resized(
        &mut self,
        label: &str,
        size: tauri::PhysicalSize<u32>,
        now: Instant,
    ) -> Option<tauri::PhysicalSize<u32>> {
        if self.lease.is_none() || self.mode_resize_until.is_none_or(|until| now > until) {
            self.mode_resize_until = None;
            return None;
        }
        if label == REMOTE {
            // A resize caused by our mode projection is harmless. An independent user
            // resize cancels the brief follow-up, so their geometry is never overwritten.
            if self.projected_size != Some(size) {
                self.mode_resize_until = None;
            }
            return None;
        }
        if label != MAIN {
            return None;
        }
        self.projected_size = Some(size);
        Some(size)
    }
}
#[derive(Default)]
pub struct RemoteCallWindowState(Mutex<ResidentState>);

fn require_label(actual: &str, required: &str) -> Result<(), String> {
    if actual == required {
        Ok(())
    } else {
        Err("This window cannot operate the remote resident".into())
    }
}
fn allowed_navigation(url: &tauri::Url, main: &tauri::Url) -> bool {
    url.scheme() == main.scheme()
        && url.host_str() == main.host_str()
        && url.port_or_known_default() == main.port_or_known_default()
        && matches!(url.path(), "/" | "/index.html")
        && url.query() == Some(QUERY)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

#[tauri::command]
pub async fn remote_call_window_begin(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
) -> Result<String, String> {
    require_label(window.label(), MAIN)?;
    for _ in 0..200 {
        {
            let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
            if !state.opening && !state.closing {
                if state.lease.is_some() {
                    return Err("Remote resident view is already active".into());
                }
                let lease = uuid::Uuid::new_v4().to_string();
                state.lease = Some(lease.clone());
                return Ok(lease);
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Err("Previous remote resident view is still closing".into())
}

#[tauri::command]
pub async fn remote_call_window_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    let main_url = window.url().map_err(|e| e.to_string())?;
    {
        let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
        state.require_lease(&lease_id)?;
        if state.opening || state.closing {
            return Err("Remote resident view is changing".into());
        }
        if app.get_webview_window(REMOTE).is_some() {
            return Ok(());
        }
        state.opening = true;
    }
    // Use the current native view's geometry. Do not modify the resident's main window.
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .map(|s| s.to_logical::<f64>(scale))
        .unwrap_or(tauri::LogicalSize::new(280.0, 560.0));
    let built = WebviewWindowBuilder::new(
        &app,
        REMOTE,
        WebviewUrl::App(format!("index.html?{QUERY}").into()),
    )
    .title("Yorishiro")
    .inner_size(
        size.width.clamp(160.0, 1200.0),
        size.height.clamp(240.0, 1600.0),
    )
    .min_inner_size(160.0, 240.0)
    .resizable(true)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .background_color(tauri::webview::Color(0, 0, 0, 0))
    .always_on_top(window.is_always_on_top().unwrap_or(true))
    .focused(false)
    .skip_taskbar(true)
    .disable_drag_drop_handler()
    .on_navigation(move |url| allowed_navigation(url, &main_url))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build();
    let cancelled = {
        let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
        state.opening = false;
        let cancelled = state.require_lease(&lease_id).is_err();
        state.closing = cancelled && built.is_ok();
        cancelled
    };
    let built = built.map_err(|e| e.to_string())?;
    if cancelled {
        built.destroy().map_err(|e| e.to_string())?;
        return Err("Remote resident view was cancelled".into());
    }
    if let (Ok(position), Ok(outer)) = (window.outer_position(), window.outer_size()) {
        let gap = (12.0 * scale) as i32;
        let mut x = position
            .x
            .saturating_add(outer.width as i32)
            .saturating_add(gap);
        if let Ok(Some(monitor)) = window.current_monitor() {
            let right = i64::from(monitor.position().x) + i64::from(monitor.size().width);
            if i64::from(x) + i64::from(outer.width) > right {
                x = position
                    .x
                    .saturating_sub(outer.width as i32)
                    .saturating_sub(gap)
                    .max(monitor.position().x);
            }
        }
        let _ = built.set_position(tauri::PhysicalPosition::new(x, position.y));
    }
    Ok(())
}

/// Only the already-admitted main owner can supply inline VRM bytes. No filesystem paths or URLs.
#[tauri::command]
pub fn remote_call_window_avatar(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
    encoded: String,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    if encoded.len() > MAX_AVATAR_BYTES.div_ceil(3) * 4 {
        return Err("Remote avatar is too large".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid remote avatar encoding")?;
    if bytes.len() < 20
        || bytes.len() > MAX_AVATAR_BYTES
        || &bytes[..4] != b"glTF"
        || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) != 2
        || u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize != bytes.len()
    {
        return Err("Remote avatar must be a bounded GLB".into());
    }
    let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
    state.require_lease(&lease_id)?;
    state.avatar = Some(bytes);
    state.avatar_revision = state.avatar_revision.saturating_add(1);
    Ok(())
}

#[tauri::command]
pub fn remote_call_window_read_avatar(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
    revision: u64,
) -> Result<tauri::ipc::Response, String> {
    require_label(window.label(), REMOTE)?;
    let state = state.0.lock().map_err(|_| "Resident state unavailable")?;
    state.require_lease(&lease_id)?;
    if revision != state.avatar_revision {
        return Err("Remote avatar has changed".into());
    }
    Ok(tauri::ipc::Response::new(
        state.avatar.clone().ok_or("Remote avatar is not ready")?,
    ))
}

#[tauri::command]
pub fn remote_call_window_publish(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    mut frame: ResidentFrame,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    frame.validate()?;
    let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
    state.require_lease(&frame.lease_id)?;
    let mode_changed = state
        .frame
        .as_ref()
        .is_some_and(|previous| previous.mode != frame.mode);
    state.sequence = state.sequence.saturating_add(1);
    frame.sequence = state.sequence;
    frame.avatar_revision = state.avatar_revision;
    let lease = frame.lease_id.clone();
    let mode = frame.mode.clone();
    state.frame = Some(frame.clone());
    app.emit_to(REMOTE, EVENT, frame)
        .map_err(|e| e.to_string())?;
    drop(state);
    if mode_changed {
        if let Some(remote) = app.get_webview_window(REMOTE) {
            // Call/Portrait are the same existing native formats after a view-mode switch.
            if let Ok(size) = window.inner_size() {
                let resident_state = app.state::<RemoteCallWindowState>();
                let mut state = resident_state
                    .0
                    .lock()
                    .map_err(|_| "Resident state unavailable")?;
                if state.require_lease(&lease).is_err()
                    || !state.frame.as_ref().is_some_and(|frame| frame.mode == mode)
                {
                    return Ok(());
                }
                state.begin_mode_resize(size, Instant::now());
                drop(state);
                let _ = remote.set_size(size);
            }
            if let Ok(on_top) = window.is_always_on_top() {
                let _ = remote.set_always_on_top(on_top);
            }
        }
    }
    Ok(())
}

/// Existing view packs resize the main window asynchronously. Follow only the short
/// mode-change transition; ordinary later resizing of either window stays independent.
pub fn window_resized(app: &AppHandle, label: &str, size: tauri::PhysicalSize<u32>) {
    if label != MAIN && label != REMOTE {
        return;
    }
    let target = app.try_state::<RemoteCallWindowState>().and_then(|state| {
        state
            .0
            .lock()
            .ok()
            .and_then(|mut state| state.resized(label, size, Instant::now()))
    });
    if let Some(size) = target {
        if let Some(remote) = app.get_webview_window(REMOTE) {
            let _ = remote.set_size(size);
        }
    }
}

#[tauri::command]
pub fn remote_call_window_snapshot(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
) -> Result<Option<ResidentFrame>, String> {
    require_label(window.label(), REMOTE)?;
    Ok(state
        .0
        .lock()
        .map_err(|_| "Resident state unavailable")?
        .frame
        .clone())
}

#[tauri::command]
pub fn remote_call_window_revoke(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    let should_close = {
        let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
        if state.require_lease(&lease_id).is_err() {
            return Ok(());
        }
        state.clear();
        state.closing = state.opening || app.get_webview_window(REMOTE).is_some();
        !state.opening
    };
    if should_close {
        if let Some(window) = app.get_webview_window(REMOTE) {
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remote_call_window_hide(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
) -> Result<(), String> {
    require_label(window.label(), REMOTE)?;
    let state = state.0.lock().map_err(|_| "Resident state unavailable")?;
    state.require_lease(&lease_id)?;
    app.emit_to(
        MAIN,
        ACTION,
        serde_json::json!({ "leaseId": lease_id, "action": "attach" }),
    )
    .map_err(|e| e.to_string())
}

pub fn window_destroyed(app: &AppHandle, label: &str) {
    if label != REMOTE {
        return;
    }
    if let Some(state) = app.try_state::<RemoteCallWindowState>() {
        let lease = state.0.lock().ok().and_then(|mut state| {
            state.closing = false;
            state.clear()
        });
        if let Some(lease_id) = lease {
            let _ = app.emit_to(
                MAIN,
                ACTION,
                serde_json::json!({ "leaseId": lease_id, "action": "attach" }),
            );
        }
    }
}
pub fn close_owned_windows(app: &AppHandle) {
    let should_close = app
        .try_state::<RemoteCallWindowState>()
        .and_then(|state| {
            state.0.lock().ok().map(|mut state| {
                state.clear();
                state.closing = state.opening || app.get_webview_window(REMOTE).is_some();
                !state.opening
            })
        })
        .unwrap_or(false);
    if should_close {
        if let Some(window) = app.get_webview_window(REMOTE) {
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mode_projection_follows_delayed_main_resize_but_respects_independent_user_resize() {
        let old_size = tauri::PhysicalSize::new(400, 600);
        let next_size = tauri::PhysicalSize::new(560, 1120);
        let now = Instant::now();
        let mut state = ResidentState {
            lease: Some("lease".into()),
            ..Default::default()
        };
        state.begin_mode_resize(old_size, now);
        assert_eq!(state.resized(REMOTE, old_size, now), None);
        assert_eq!(
            state.resized(MAIN, next_size, now + Duration::from_millis(300)),
            Some(next_size)
        );
        assert_eq!(
            state.resized(REMOTE, next_size, now + Duration::from_millis(301)),
            None
        );
        assert_eq!(
            state.resized(MAIN, old_size, now + Duration::from_secs(2)),
            None
        );
        state.begin_mode_resize(old_size, now);
        state.resized(
            REMOTE,
            tauri::PhysicalSize::new(640, 900),
            now + Duration::from_millis(10),
        );
        assert_eq!(
            state.resized(MAIN, next_size, now + Duration::from_millis(300)),
            None
        );
        state.begin_mode_resize(old_size, now);
        state.clear();
        assert_eq!(state.resized(MAIN, next_size, now), None);
    }
    fn frame() -> ResidentFrame {
        ResidentFrame {
            lease_id: "lease".into(),
            label: "Mafu".into(),
            language: "ja".into(),
            mode: "call".into(),
            motion: Some(vec![0; 505]),
            mouth: [0.0; 5],
            sequence: 0,
            avatar_revision: 0,
            camera: ResidentCamera {
                position: [0.0, 1.5, 0.84],
                quaternion: [0.0, 0.0, 0.0, 1.0],
                fov: 35.0,
                zoom: 1.0,
                near: 0.1,
                far: 20.0,
                anchor_y: 1.5,
            },
        }
    }
    #[test]
    fn public_projection_schema_bounds_motion_camera_and_names() {
        assert!(frame().validate().is_ok());
        let mut value = frame();
        value.motion = Some(vec![0; 506]);
        assert!(value.validate().is_err());
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 1.01] {
            let mut value = frame();
            value.mouth[0] = invalid;
            assert!(value.validate().is_err());
        }
        let mut value = frame();
        value.camera.quaternion = [0.0; 4];
        assert!(value.validate().is_err());
        let mut value = frame();
        value.label = "Remote\nHidden text".into();
        assert!(value.validate().is_err());
        let mut value = serde_json::to_value(frame()).unwrap();
        value["privateContext"] = "secret".into();
        assert!(serde_json::from_value::<ResidentFrame>(value).is_err());
    }
    #[test]
    fn leases_revoke_old_avatars_and_frames() {
        let mut state = ResidentState {
            lease: Some("first".into()),
            avatar: Some(vec![1]),
            ..Default::default()
        };
        assert!(state.require_lease("first").is_ok());
        state.clear();
        state.lease = Some("second".into());
        assert!(state.require_lease("first").is_err());
        assert!(state.avatar.is_none());
    }
    #[test]
    fn consumer_cannot_publish_or_navigate_to_main_or_remote_code() {
        assert!(require_label(REMOTE, MAIN).is_err());
        assert!(require_label(MAIN, REMOTE).is_err());
        let main = tauri::Url::parse("tauri://localhost/").unwrap();
        assert!(allowed_navigation(
            &tauri::Url::parse("tauri://localhost/?auxiliary=call-resident").unwrap(),
            &main
        ));
        for url in [
            "https://example.com/?auxiliary=call-resident",
            "tauri://localhost/",
            "tauri://localhost/?auxiliary=camera-preview",
            "tauri://localhost/?auxiliary=call-resident#x",
        ] {
            assert!(!allowed_navigation(&tauri::Url::parse(url).unwrap(), &main));
        }
    }
}
