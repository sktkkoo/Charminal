//! Host-owned auxiliary UI. A window kind selects a bundled view; callers never supply a URL.
//! Only the main view publishes state, and auxiliary actions go back to that same owner.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN_LABEL: &str = "main";
const CONTROLS_LABEL: &str = "auxiliary-screen-sharing-controls";
const STATE_EVENT: &str = "auxiliary-window-state";
const ACTION_EVENT: &str = "auxiliary-window-action";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuxiliaryWindowKind {
    ScreenSharingControls,
}

impl AuxiliaryWindowKind {
    fn label(self) -> &'static str {
        match self {
            Self::ScreenSharingControls => CONTROLS_LABEL,
        }
    }

    fn route(self) -> &'static str {
        match self {
            Self::ScreenSharingControls => "screen-sharing-controls",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SharedDisplay {
    id: u32,
    name: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SharingSourceKind {
    #[default]
    Screen,
    Camera,
}

/// Deliberately excludes image data, agent/thread identifiers, arbitrary error text, and credentials.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenSharingSnapshot {
    revision: String,
    pointer_revision: String,
    available: bool,
    active: bool,
    busy: bool,
    pointers_enabled: bool,
    pointers_ready: bool,
    sources: Vec<SharedDisplay>,
    #[serde(default)]
    source_kind: SharingSourceKind,
    source_id: Option<u32>,
    interval_seconds: u8,
    has_error: bool,
    last_observed_at: Option<u64>,
    language: String,
}

impl ScreenSharingSnapshot {
    fn validate(&self) -> Result<(), String> {
        if self.revision.is_empty()
            || self.revision.len() > 80
            || self.pointer_revision.is_empty()
            || self.pointer_revision.len() > 80
        {
            return Err("Invalid auxiliary state revision".into());
        }
        if !(20..=60).contains(&self.interval_seconds) {
            return Err("Viewing interval must be between 20 and 60 seconds".into());
        }
        if self.sources.len() > 64 || self.sources.iter().any(|source| source.name.len() > 800) {
            return Err("Invalid display list".into());
        }
        if self.language != "en" && self.language != "ja" {
            return Err("Unsupported auxiliary language".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ScreenSharingAction {
    Start,
    Stop,
    RefreshSources,
    ClearAnnotations,
    RetryPointers,
    SetPointersEnabled {
        enabled: bool,
    },
    SelectSourceKind {
        #[serde(rename = "sourceKind")]
        source_kind: SharingSourceKind,
    },
    SelectSource {
        #[serde(rename = "sourceId")]
        source_id: u32,
    },
    SetInterval {
        #[serde(rename = "intervalSeconds")]
        interval_seconds: u8,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuxiliaryActionRequest {
    version: u64,
    pointer_revision: Option<String>,
    action: ScreenSharingAction,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSnapshot {
    version: u64,
    snapshot: ScreenSharingSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutedAction {
    revision: String,
    pointer_revision: String,
    action: ScreenSharingAction,
}

#[derive(Default)]
struct AuxiliaryState {
    version: u64,
    snapshot: Option<PublishedSnapshot>,
}

#[derive(Default)]
pub struct AuxiliaryWindowsState(Mutex<AuxiliaryState>);

fn require_label(actual: &str, required: &str) -> Result<(), String> {
    if actual == required {
        Ok(())
    } else {
        Err("This window cannot perform that auxiliary operation".into())
    }
}

fn is_allowed_navigation(url: &tauri::Url, main_url: &tauri::Url, query: &str) -> bool {
    // url::Origin is opaque for tauri:// on macOS, so compare its actual authority instead.
    url.scheme() == main_url.scheme()
        && url.host_str() == main_url.host_str()
        && url.port_or_known_default() == main_url.port_or_known_default()
        && matches!(url.path(), "/" | "/index.html")
        && url.query() == Some(query)
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_action(
    published: &PublishedSnapshot,
    request: &AuxiliaryActionRequest,
) -> Result<(), String> {
    let pointer_setting = matches!(
        &request.action,
        ScreenSharingAction::SetPointersEnabled { .. } | ScreenSharingAction::RetryPointers
    );
    let current_revision = if pointer_setting {
        request.pointer_revision.as_deref() == Some(published.snapshot.pointer_revision.as_str())
    } else {
        published.version == request.version
    };
    if !current_revision {
        return Err("Sharing settings changed. Please try again.".into());
    }
    let snapshot = &published.snapshot;
    match &request.action {
        ScreenSharingAction::Start
            if !snapshot.available
                || (snapshot.source_kind != SharingSourceKind::Camera
                    && !snapshot.pointers_ready)
                || snapshot.active
                || snapshot.busy
                || !snapshot
                    .sources
                    .iter()
                    .any(|source| Some(source.id) == snapshot.source_id) =>
        {
            Err("Screen sharing is not ready to start".into())
        }
        ScreenSharingAction::SetPointersEnabled { .. }
        | ScreenSharingAction::RetryPointers
        | ScreenSharingAction::ClearAnnotations
            if snapshot.source_kind == SharingSourceKind::Camera =>
        {
            Err("Desktop pointers are not available for camera sharing".into())
        }
        ScreenSharingAction::SetPointersEnabled { .. } if !snapshot.pointers_ready => {
            Err("Screen pointer settings are not ready".into())
        }
        ScreenSharingAction::RetryPointers if snapshot.pointers_ready || !snapshot.has_error => {
            Err("Screen pointer settings do not need initialization".into())
        }
        ScreenSharingAction::SelectSource { source_id }
            if snapshot.active
                || snapshot.busy
                || !snapshot
                    .sources
                    .iter()
                    .any(|source| source.id == *source_id) =>
        {
            Err("Stop sharing before selecting an available display".into())
        }
        ScreenSharingAction::RefreshSources if snapshot.active || snapshot.busy => {
            Err("Stop sharing before refreshing displays".into())
        }
        ScreenSharingAction::SetInterval { interval_seconds }
            if !(20..=60).contains(interval_seconds) =>
        {
            Err("Viewing interval must be between 20 and 60 seconds".into())
        }
        _ => Ok(()),
    }
}

/// Explicitly opening controls is the only path that changes auxiliary focus.
#[tauri::command]
pub async fn auxiliary_window_open(
    app: AppHandle,
    window: WebviewWindow,
    kind: AuxiliaryWindowKind,
) -> Result<(), String> {
    require_label(window.label(), MAIN_LABEL)?;
    if let Some(existing) = app.get_webview_window(kind.label()) {
        existing.unminimize().map_err(|error| error.to_string())?;
        existing.show().map_err(|error| error.to_string())?;
        return existing.set_focus().map_err(|error| error.to_string());
    }
    let main_url = window.url().map_err(|error| error.to_string())?;
    let query = format!("auxiliary={}", kind.route());
    let resource = format!("index.html?{query}");
    WebviewWindowBuilder::new(&app, kind.label(), WebviewUrl::App(resource.into()))
        .title("Screen sharing — Yorishiro")
        .inner_size(360.0, 530.0)
        .min_inner_size(320.0, 400.0)
        .resizable(true)
        .always_on_top(true)
        .focused(true)
        .skip_taskbar(true)
        .disable_drag_drop_handler()
        .on_navigation(move |url| is_allowed_navigation(url, &main_url, &query))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn auxiliary_window_publish(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AuxiliaryWindowsState>,
    snapshot: ScreenSharingSnapshot,
) -> Result<(), String> {
    require_label(window.label(), MAIN_LABEL)?;
    snapshot.validate()?;
    let published = {
        let mut state = state.0.lock().map_err(|error| error.to_string())?;
        state.version = state.version.saturating_add(1);
        let published = PublishedSnapshot {
            version: state.version,
            snapshot,
        };
        state.snapshot = Some(published.clone());
        published
    };
    // Never show or focus a window as a side effect of a state refresh or sharing stop.
    app.emit_to(CONTROLS_LABEL, STATE_EVENT, published)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn auxiliary_window_snapshot(
    window: WebviewWindow,
    state: State<'_, AuxiliaryWindowsState>,
) -> Result<Option<PublishedSnapshot>, String> {
    require_label(window.label(), CONTROLS_LABEL)?;
    Ok(state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .snapshot
        .clone())
}

#[tauri::command]
pub fn auxiliary_window_request_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AuxiliaryWindowsState>,
    request: AuxiliaryActionRequest,
) -> Result<(), String> {
    require_label(window.label(), CONTROLS_LABEL)?;
    let routed = {
        let state = state.0.lock().map_err(|error| error.to_string())?;
        let published = state
            .snapshot
            .as_ref()
            .ok_or("The main window is not ready")?;
        validate_action(published, &request)?;
        RoutedAction {
            revision: published.snapshot.revision.clone(),
            pointer_revision: published.snapshot.pointer_revision.clone(),
            action: request.action,
        }
    };
    if app.get_webview_window(MAIN_LABEL).is_none() {
        return Err("The main window is closed".into());
    }
    app.emit_to(MAIN_LABEL, ACTION_EVENT, routed)
        .map_err(|error| error.to_string())
}

/// Called when the owning main window is destroyed, including native close and app shutdown.
pub fn close_owned_windows(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CONTROLS_LABEL) {
        let _ = window.destroy();
    }
    if let Some(state) = app.try_state::<AuxiliaryWindowsState>() {
        if let Ok(mut state) = state.0.lock() {
            state.snapshot = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn published() -> PublishedSnapshot {
        PublishedSnapshot {
            version: 7,
            snapshot: ScreenSharingSnapshot {
                revision: "main-owner-revision".into(),
                pointer_revision: "pointer-owner-revision".into(),
                available: true,
                active: false,
                busy: false,
                pointers_enabled: true,
                pointers_ready: true,
                sources: vec![SharedDisplay {
                    id: 12,
                    name: "Display 1".into(),
                }],
                source_kind: SharingSourceKind::Screen,
                source_id: Some(12),
                interval_seconds: 30,
                has_error: false,
                last_observed_at: None,
                language: "ja".into(),
            },
        }
    }

    #[test]
    fn only_the_intended_window_can_publish_or_request() {
        assert!(require_label(MAIN_LABEL, MAIN_LABEL).is_ok());
        assert!(require_label(CONTROLS_LABEL, MAIN_LABEL).is_err());
        assert!(require_label(MAIN_LABEL, CONTROLS_LABEL).is_err());
        assert!(require_label("untrusted", CONTROLS_LABEL).is_err());
    }

    #[test]
    fn rejects_unknown_window_kinds_and_image_or_credential_fields() {
        assert!(serde_json::from_str::<AuxiliaryWindowKind>("\"https://example.com\"").is_err());
        let mut json = serde_json::to_value(published().snapshot).unwrap();
        for field in ["imageDataUrl", "token", "ownerKey", "error"] {
            json[field] = serde_json::json!("must not cross this bridge");
            assert!(serde_json::from_value::<ScreenSharingSnapshot>(json.clone()).is_err());
            json.as_object_mut().unwrap().remove(field);
        }
    }

    #[test]
    fn navigation_accepts_the_bundled_view_on_tauri_and_dev_origins_only() {
        let query = "auxiliary=screen-sharing-controls";
        for origin in [
            "tauri://localhost",
            "http://localhost:1430",
            "http://tauri.localhost",
        ] {
            let main = tauri::Url::parse(&format!("{origin}/")).unwrap();
            let bundled = tauri::Url::parse(&format!("{origin}/index.html?{query}")).unwrap();
            assert!(is_allowed_navigation(&bundled, &main, query));
            for destination in [
                format!("https://example.com/index.html?{query}"),
                format!("{origin}/index.html?auxiliary=unknown"),
                format!("{origin}/other.html?{query}"),
            ] {
                assert!(!is_allowed_navigation(
                    &tauri::Url::parse(&destination).unwrap(),
                    &main,
                    query
                ));
            }
        }
    }

    #[test]
    fn stale_controls_cannot_start_or_stop_a_replacement_share() {
        for action in [
            ScreenSharingAction::Start,
            ScreenSharingAction::Stop,
            ScreenSharingAction::RetryPointers,
        ] {
            assert!(validate_action(
                &published(),
                &AuxiliaryActionRequest {
                    version: 6,
                    pointer_revision: None,
                    action
                }
            )
            .is_err());
        }
    }

    #[test]
    fn validates_source_interval_and_availability() {
        let mut state = published();
        let request = |action| AuxiliaryActionRequest {
            version: 7,
            pointer_revision: None,
            action,
        };
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_ok());
        state.snapshot.available = false;
        assert!(validate_action(&state, &request(ScreenSharingAction::Start)).is_err());
        assert!(validate_action(
            &state,
            &request(ScreenSharingAction::SelectSource { source_id: 99 })
        )
        .is_err());
        for interval_seconds in [5, 19, 61] {
            assert!(validate_action(
                &state,
                &request(ScreenSharingAction::SetInterval { interval_seconds })
            )
            .is_err());
            state.snapshot.interval_seconds = interval_seconds;
            assert!(state.snapshot.validate().is_err());
        }
        for interval_seconds in [20, 30, 60] {
            assert!(validate_action(
                &state,
                &request(ScreenSharingAction::SetInterval { interval_seconds })
            )
            .is_ok());
            state.snapshot.interval_seconds = interval_seconds;
            assert!(state.snapshot.validate().is_ok());
        }
        state.snapshot.active = true;
        assert!(validate_action(
            &state,
            &request(ScreenSharingAction::SelectSource { source_id: 12 })
        )
        .is_err());
        assert!(validate_action(&state, &request(ScreenSharingAction::RefreshSources)).is_err());
        assert!(validate_action(&state, &request(ScreenSharingAction::Stop)).is_ok());
        assert!(validate_action(&state, &request(ScreenSharingAction::ClearAnnotations)).is_ok());
    }

    #[test]
    fn pointer_toggle_is_independent_of_capture_but_rejects_stale_or_unready_controls() {
        let mut state = published();
        state.snapshot.available = false;
        state.snapshot.busy = true;
        let request = |enabled| AuxiliaryActionRequest {
            version: state.version,
            pointer_revision: Some(state.snapshot.pointer_revision.clone()),
            action: ScreenSharingAction::SetPointersEnabled { enabled },
        };
        for enabled in [false, true] {
            assert!(validate_action(&state, &request(enabled)).is_ok());
        }
        let mut stale = request(false);
        stale.version -= 1;
        assert!(validate_action(&state, &stale).is_ok());
        stale.pointer_revision = Some("old-owner-or-setting".into());
        assert!(validate_action(&state, &stale).is_err());
        state.snapshot.pointers_ready = false;
        assert!(validate_action(&state, &request(false)).is_err());
        assert!(
            serde_json::from_value::<ScreenSharingAction>(serde_json::json!({
                "type": "set-pointers-enabled", "enabled": "true"
            }))
            .is_err()
        );
    }

    #[test]
    fn capture_updates_preserve_pointer_actions_but_owner_or_pointer_changes_reject_them() {
        let mut state = published();
        let off = AuxiliaryActionRequest {
            version: state.version,
            pointer_revision: Some(state.snapshot.pointer_revision.clone()),
            action: ScreenSharingAction::SetPointersEnabled { enabled: false },
        };
        state.version += 1;
        state.snapshot.revision = "capture-finished-revision".into();
        state.snapshot.last_observed_at = Some(1000);
        assert!(validate_action(&state, &off).is_ok());
        state.snapshot.pointer_revision = "new-owner-or-pointer-setting".into();
        assert!(validate_action(&state, &off).is_err());
    }
}
