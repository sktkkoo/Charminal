//! Pre-admission presentation only. Call ownership, voice and agents stay in main.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const MAIN: &str = "main";
pub const LABEL: &str = "auxiliary-call-controls";
const STATE_EVENT: &str = "call-controls-state";
const ACTION_EVENT: &str = "call-controls-action";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Guest {
    name: String,
    request_id: String,
}

/// No paths, avatars, persona, credentials, audio or transcript payloads.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    revision: String,
    owner_key: String,
    enabled: bool,
    language: String,
    name: String,
    local_name: String,
    remote_name: String,
    active: bool,
    connected: bool,
    busy: Option<String>,
    status: String,
    error: String,
    notice: String,
    endpoint: String,
    signal_state: String,
    role: String,
    invitation: String,
    guest: Option<Guest>,
}

impl Snapshot {
    fn validate(&self) -> Result<(), String> {
        if self.revision.is_empty()
            || self.revision.len() > 80
            || self.owner_key.is_empty()
            || self.owner_key.len() > 80
            || !matches!(self.language.as_str(), "en" | "ja")
            || self.name.chars().count() > 64
            || self.local_name.chars().count() > 64
            || self.remote_name.chars().count() > 64
            || self.busy.as_ref().is_some_and(|value| value.len() > 40)
            || self.status.len() > 1024
            || self.error.len() > 8192
            || self.notice.len() > 2048
            || self.endpoint.len() > 8192
            || self.signal_state.len() > 40
            || self.role.len() > 16
            || self.invitation.len() > 64
            || self.guest.as_ref().is_some_and(|guest| {
                guest.name.chars().count() > 64
                    || guest.request_id.is_empty()
                    || guest.request_id.len() > 80
            })
        {
            return Err("Invalid call controls state".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Create {
        name: String,
    },
    Join {
        name: String,
        invitation: String,
    },
    SaveEndpoint {
        endpoint: String,
    },
    Accept {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Decline {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Cancel,
    Hide,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    version: u64,
    action: Action,
}
#[derive(Clone, Serialize)]
pub struct Published {
    version: u64,
    snapshot: Snapshot,
}
#[derive(Clone, Serialize)]
struct Routed {
    revision: String,
    action: Action,
}
#[derive(Default)]
struct Inner {
    version: u64,
    snapshot: Option<Published>,
}
#[derive(Default)]
pub struct CallControlsState(Mutex<Inner>);

fn require_label(window: &str, required: &str) -> Result<(), String> {
    if window == required {
        Ok(())
    } else {
        Err("This window cannot control call admission".into())
    }
}
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.encode_utf16().count() <= 64
        && !name.chars().any(|c| c < ' ' || c == '\u{7f}')
}
fn valid_invitation(value: &str) -> bool {
    value.len() == 27
        && value.starts_with("yri1_")
        && value[5..]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn allowed(published: &Published, request: &Request) -> bool {
    let state = &published.snapshot;
    if request.version != published.version || !state.enabled || state.connected {
        return false;
    }
    if matches!(request.action, Action::Hide) {
        return true;
    }
    if matches!(request.action, Action::Cancel) {
        return state.active;
    }
    if state.busy.is_some() {
        return false;
    }
    match &request.action {
        Action::Accept { request_id } | Action::Decline { request_id } => {
            state.active
                && state.signal_state == "pending"
                && state
                    .guest
                    .as_ref()
                    .is_some_and(|guest| &guest.request_id == request_id)
        }
        Action::Create { name } => !state.active && !state.endpoint.is_empty() && valid_name(name),
        Action::Join { name, invitation } => {
            !state.active
                && !state.endpoint.is_empty()
                && valid_name(name)
                && valid_invitation(invitation)
        }
        Action::SaveEndpoint { endpoint } => {
            !state.active && !endpoint.trim().is_empty() && endpoint.encode_utf16().count() <= 2048
        }
        _ => false,
    }
}

#[tauri::command]
pub fn call_controls_publish(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CallControlsState>,
    snapshot: Snapshot,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    snapshot.validate()?;
    let published = {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        inner.version = inner.version.saturating_add(1);
        let published = Published {
            version: inner.version,
            snapshot,
        };
        inner.snapshot = Some(published.clone());
        published
    };
    app.emit_to(LABEL, STATE_EVENT, published)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn call_controls_snapshot(
    window: WebviewWindow,
    state: State<'_, CallControlsState>,
) -> Result<Option<Published>, String> {
    require_label(window.label(), LABEL)?;
    Ok(state.0.lock().map_err(|e| e.to_string())?.snapshot.clone())
}
#[tauri::command]
pub fn call_controls_request_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, CallControlsState>,
    request: Request,
) -> Result<(), String> {
    require_label(window.label(), LABEL)?;
    let routed = {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        let published = inner
            .snapshot
            .as_ref()
            .ok_or("Call controls are not ready")?;
        if !allowed(published, &request) {
            return Err("Call state changed. Please try again.".into());
        }
        Routed {
            revision: published.snapshot.revision.clone(),
            action: request.action,
        }
    };
    app.emit_to(MAIN, ACTION_EVENT, routed)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn call_controls_hide(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    if let Some(controls) = app.get_webview_window(LABEL) {
        controls.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn window_destroyed(app: &AppHandle, label: &str) {
    if label == LABEL {
        let _ = app.emit_to(MAIN, "call-controls-closed", ());
    }
}
pub fn close_owned_windows(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    if let Some(state) = app.try_state::<CallControlsState>() {
        if let Ok(mut inner) = state.0.lock() {
            inner.snapshot = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn published() -> Published {
        Published {
            version: 4,
            snapshot: Snapshot {
                revision: "revision".into(),
                owner_key: "current-owner".into(),
                enabled: true,
                language: "ja".into(),
                name: "より".into(),
                local_name: "より".into(),
                remote_name: "GPT".into(),
                active: false,
                connected: false,
                busy: None,
                status: "".into(),
                error: "".into(),
                notice: "".into(),
                endpoint: "ws://localhost:1531/rooms".into(),
                signal_state: "idle".into(),
                role: "".into(),
                invitation: "".into(),
                guest: None,
            },
        }
    }
    #[test]
    fn refuses_stale_hidden_connected_and_invalid_entry_requests() {
        let mut state = published();
        let request = Request {
            version: 4,
            action: Action::Create {
                name: "より".into(),
            },
        };
        assert!(allowed(&state, &request));
        state.version += 1;
        assert!(!allowed(&state, &request));
        state.version = 4;
        state.snapshot.enabled = false;
        assert!(!allowed(&state, &request));
        state.snapshot.enabled = true;
        state.snapshot.connected = true;
        assert!(!allowed(&state, &request));
        state.snapshot.connected = false;
        for name in ["", "\n", &"x".repeat(65)] {
            assert!(!allowed(
                &state,
                &Request {
                    version: 4,
                    action: Action::Create { name: name.into() }
                }
            ));
        }
        assert!(!allowed(
            &state,
            &Request {
                version: 4,
                action: Action::Join {
                    name: "より".into(),
                    invitation: "https://untrusted.example".into()
                }
            }
        ));
        assert!(!valid_invitation("yri1_あいうえおかき"));
    }
    #[test]
    fn admission_is_for_current_request_and_cancel_remains_available_while_busy() {
        let mut state = published();
        state.snapshot.active = true;
        state.snapshot.signal_state = "pending".into();
        state.snapshot.guest = Some(Guest {
            name: "GPT".into(),
            request_id: "request-current".into(),
        });
        assert!(!allowed(
            &state,
            &Request {
                version: 4,
                action: Action::Accept {
                    request_id: "request-old".into()
                }
            }
        ));
        assert!(allowed(
            &state,
            &Request {
                version: 4,
                action: Action::Accept {
                    request_id: "request-current".into()
                }
            }
        ));
        state.snapshot.busy = Some("accept".into());
        assert!(!allowed(
            &state,
            &Request {
                version: 4,
                action: Action::Accept {
                    request_id: "request-current".into()
                }
            }
        ));
        assert!(allowed(
            &state,
            &Request {
                version: 4,
                action: Action::Cancel
            }
        ));
        assert!(allowed(
            &state,
            &Request {
                version: 4,
                action: Action::Hide
            }
        ));
    }
    #[test]
    fn native_label_and_payload_schema_are_bounded() {
        assert!(require_label("main", MAIN).is_ok());
        assert!(require_label(LABEL, MAIN).is_err());
        assert!(require_label("unrelated", LABEL).is_err());
        let mut snapshot = published().snapshot;
        assert!(snapshot.validate().is_ok());
        snapshot.error = "x".repeat(8193);
        assert!(snapshot.validate().is_err());
        assert!(serde_json::from_value::<Request>(serde_json::json!({"version":4,"action":{"type":"accept","requestId":"current","url":"https://example.com"}})).is_err());
    }
}
