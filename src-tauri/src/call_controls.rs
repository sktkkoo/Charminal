//! Pre-admission presentation only. Call ownership, voice and agents stay in main.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contact {
    identity_id: String,
    name: String,
    last_accepted_at: u64,
}

/// Public caller metadata only. The main window retains the invitation and identity keys.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Incoming {
    room_id: String,
    identity_id: String,
    name: String,
    expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceState {
    Idle,
    Connecting,
    Online,
    Offline,
    Error,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    contacts: Option<Vec<Contact>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    incoming: Option<Incoming>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    presence_state: Option<PresenceState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    presence_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    direct_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failed_contact_id: Option<String>,
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
            || self.presence_error.as_ref().is_some_and(|message| {
                message.len() > 1024 || message.chars().any(char::is_control)
            })
            || self.endpoint.len() > 8192
            || self.signal_state.len() > 40
            || self.role.len() > 16
            || self.invitation.len() > 64
            || self.guest.as_ref().is_some_and(|guest| {
                guest.name.chars().count() > 64
                    || guest.request_id.is_empty()
                    || guest.request_id.len() > 80
            })
            || self.direct_target.as_ref().is_some_and(|name| {
                name.encode_utf16().count() > 64 || name.chars().any(char::is_control)
            })
            || self.failed_contact_id.as_ref().is_some_and(|id| {
                !id.is_empty()
                    && (!valid_identity(id)
                        || !self.contacts.as_ref().is_some_and(|contacts| {
                            contacts.iter().any(|contact| &contact.identity_id == id)
                        }))
            })
            || self.contacts.as_ref().is_some_and(|contacts| {
                let mut ids = HashSet::new();
                contacts.len() > 100
                    || contacts.iter().any(|contact| {
                        !valid_identity(&contact.identity_id)
                            || !ids.insert(&contact.identity_id)
                            || !valid_name(&contact.name)
                            || contact.last_accepted_at > MAX_TIMESTAMP
                    })
            })
            || self.incoming.as_ref().is_some_and(|incoming| {
                !valid_room(&incoming.room_id)
                    || !valid_identity(&incoming.identity_id)
                    || !valid_name(&incoming.name)
                    || incoming.expires_at > MAX_TIMESTAMP
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
    CallContact {
        name: String,
        #[serde(rename = "identityId")]
        identity_id: String,
    },
    AnswerContact {
        #[serde(rename = "roomId")]
        room_id: String,
    },
    DeclineContact {
        #[serde(rename = "roomId")]
        room_id: String,
    },
    RemoveContact {
        #[serde(rename = "identityId")]
        identity_id: String,
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
    if let Some(token) = value.strip_prefix("yri1_") {
        return valid_base64url(token, 22);
    }
    value
        .strip_prefix("yri2_")
        .and_then(|value| value.split_once('_'))
        .is_some_and(|(room, token)| valid_room(room) && valid_base64url(token, 22))
}
const MAX_TIMESTAMP: u64 = 9_007_199_254_740_991;
fn valid_base64url(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn valid_identity(value: &str) -> bool {
    valid_base64url(value, 43)
}
fn valid_room(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == value)
}
fn allowed(published: &Published, request: &Request) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(u64::MAX, |value| {
            value.as_millis().min(u64::MAX as u128) as u64
        });
    allowed_at(published, request, now)
}
fn allowed_at(published: &Published, request: &Request, now: u64) -> bool {
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
        Action::CallContact { name, identity_id } => {
            !state.active
                && !state.endpoint.is_empty()
                && valid_name(name)
                && state.contacts.as_ref().is_some_and(|contacts| {
                    contacts
                        .iter()
                        .any(|contact| &contact.identity_id == identity_id)
                })
        }
        Action::RemoveContact { identity_id } => {
            !state.active
                && state.contacts.as_ref().is_some_and(|contacts| {
                    contacts
                        .iter()
                        .any(|contact| &contact.identity_id == identity_id)
                })
        }
        Action::AnswerContact { room_id } | Action::DeclineContact { room_id } => {
            !state.active
                && state.incoming.as_ref().is_some_and(|incoming| {
                    &incoming.room_id == room_id && incoming.expires_at > now
                })
        }
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
    const ID: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ROOM: &str = "12345678-1234-4234-8234-123456789012";
    fn contact() -> Contact {
        Contact {
            identity_id: ID.into(),
            name: "Mai".into(),
            last_accepted_at: 1_000,
        }
    }
    fn incoming() -> Incoming {
        Incoming {
            room_id: ROOM.into(),
            identity_id: ID.into(),
            name: "Mai".into(),
            expires_at: 2_000,
        }
    }
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
                contacts: None,
                incoming: None,
                presence_state: None,
                presence_error: None,
                direct_target: None,
                failed_contact_id: None,
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

    #[test]
    fn managed_snapshot_accepts_public_metadata_and_legacy_omissions() {
        let old = serde_json::to_value(published().snapshot).unwrap();
        assert!(old.get("contacts").is_none());
        assert!(old.get("incoming").is_none());
        assert!(old.get("presenceError").is_none());
        assert!(serde_json::from_value::<Snapshot>(old)
            .unwrap()
            .validate()
            .is_ok());
        let mut snapshot = published().snapshot;
        snapshot.contacts = Some(vec![contact()]);
        snapshot.incoming = Some(incoming());
        snapshot.presence_state = Some(PresenceState::Online);
        snapshot.direct_target = Some("Mai".into());
        assert!(snapshot.validate().is_ok());
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["contacts"][0]["identityId"], ID);
        assert_eq!(value["incoming"]["roomId"], ROOM);
        assert_eq!(value["presenceState"], "online");
        assert!(value["incoming"].get("invitation").is_none());
    }

    #[test]
    fn presence_error_round_trips_and_rejects_unbounded_payloads() {
        let mut snapshot = published().snapshot;
        snapshot.presence_state = Some(PresenceState::Error);
        snapshot.presence_error =
            Some("通話の識別情報を準備できませんでした。アプリを再起動してお試しください。".into());
        let value = serde_json::to_value(snapshot).unwrap();
        let mut restored: Snapshot = serde_json::from_value(value).unwrap();
        assert!(restored.validate().is_ok());
        assert_eq!(
            restored.presence_error.as_deref(),
            Some("通話の識別情報を準備できませんでした。アプリを再起動してお試しください。")
        );
        restored.presence_error = Some("x".repeat(1025));
        assert!(restored.validate().is_err());
        restored.presence_error = Some("message\nraw diagnostic".into());
        assert!(restored.validate().is_err());
    }

    #[test]
    fn contact_error_is_only_attached_to_a_current_contact() {
        let mut snapshot = published().snapshot;
        snapshot.failed_contact_id = Some(String::new());
        assert!(snapshot.validate().is_ok());
        snapshot.failed_contact_id = Some(ID.into());
        assert!(snapshot.validate().is_err());
        snapshot.contacts = Some(vec![contact()]);
        assert!(snapshot.validate().is_ok());
        snapshot.failed_contact_id = Some("B".repeat(43));
        assert!(snapshot.validate().is_err());
        snapshot.failed_contact_id = Some("private-error-text".into());
        assert!(snapshot.validate().is_err());
    }

    #[test]
    fn rejects_secret_or_unknown_fields_and_invalid_presence() {
        let mut state = published().snapshot;
        state.contacts = Some(vec![contact()]);
        state.incoming = Some(incoming());
        let value = serde_json::to_value(state).unwrap();
        for field in ["invitation", "privateKey", "signature", "publicKey"] {
            let mut bad = value.clone();
            bad["incoming"][field] = serde_json::json!("secret");
            assert!(serde_json::from_value::<Snapshot>(bad).is_err());
            let mut bad = value.clone();
            bad["contacts"][0][field] = serde_json::json!("secret");
            assert!(serde_json::from_value::<Snapshot>(bad).is_err());
        }
        let mut bad = value.clone();
        bad["presenceState"] = serde_json::json!("authenticated-with-private-key");
        assert!(serde_json::from_value::<Snapshot>(bad).is_err());
        for timestamp in [serde_json::json!(-1), serde_json::json!(1.5)] {
            let mut bad = value.clone();
            bad["incoming"]["expiresAt"] = timestamp;
            assert!(serde_json::from_value::<Snapshot>(bad).is_err());
        }
    }

    #[test]
    fn bounds_contacts_identifiers_names_and_timestamps() {
        let mut state = published().snapshot;
        let contacts = (0..100)
            .map(|index| Contact {
                identity_id: format!("{:043}", index),
                ..contact()
            })
            .collect::<Vec<_>>();
        state.contacts = Some(contacts.clone());
        assert!(state.validate().is_ok());
        state.contacts.as_mut().unwrap().push(Contact {
            identity_id: format!("{:043}", 100),
            ..contact()
        });
        assert!(state.validate().is_err());
        state.contacts = Some(vec![contact(), contact()]);
        assert!(state.validate().is_err());
        for id in [
            "short".to_owned(),
            "A".repeat(44),
            format!("{}=", "A".repeat(42)),
            "あ".repeat(43),
        ] {
            state.contacts = Some(vec![Contact {
                identity_id: id,
                ..contact()
            }]);
            assert!(state.validate().is_err());
        }
        for name in [
            "".to_owned(),
            "Mai\nsecret".to_owned(),
            "a".repeat(65),
            "😀".repeat(33),
        ] {
            state.contacts = Some(vec![Contact { name, ..contact() }]);
            assert!(state.validate().is_err());
        }
        state.contacts = Some(vec![Contact {
            name: "😀".repeat(32),
            last_accepted_at: MAX_TIMESTAMP,
            ..contact()
        }]);
        assert!(state.validate().is_ok());
        state.contacts.as_mut().unwrap()[0].last_accepted_at += 1;
        assert!(state.validate().is_err());
        state.contacts = None;
        state.incoming = Some(Incoming {
            room_id: "12345678-1234-1234-8234-123456789012".into(),
            ..incoming()
        });
        assert!(state.validate().is_err());
        state.incoming = Some(Incoming {
            expires_at: MAX_TIMESTAMP + 1,
            ..incoming()
        });
        assert!(state.validate().is_err());
        state.incoming = None;
        state.direct_target = Some("😀".repeat(33));
        assert!(state.validate().is_err());
    }

    #[test]
    fn contact_actions_require_current_contact_and_idle_state() {
        let mut state = published();
        let actions = [
            Action::CallContact {
                name: "より".into(),
                identity_id: ID.into(),
            },
            Action::RemoveContact {
                identity_id: ID.into(),
            },
        ];
        for action in actions {
            let request = Request { version: 4, action };
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.contacts = Some(vec![contact()]);
            assert!(allowed_at(&state, &request, 1_000));
            state.snapshot.contacts = Some(vec![Contact {
                identity_id: "B".repeat(43),
                ..contact()
            }]);
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.contacts = Some(vec![contact()]);
            state.snapshot.active = true;
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.active = false;
            state.snapshot.busy = Some("ringing".into());
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.busy = None;
            state.snapshot.connected = true;
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.connected = false;
            state.version = 5;
            assert!(!allowed_at(&state, &request, 1_000));
            state.version = 4;
            state.snapshot.contacts = None;
        }
        state.snapshot.contacts = Some(vec![contact()]);
        assert!(!allowed_at(
            &state,
            &Request {
                version: 4,
                action: Action::CallContact {
                    name: "\n".into(),
                    identity_id: ID.into()
                }
            },
            1_000
        ));
    }

    #[test]
    fn incoming_actions_require_exact_unexpired_current_room_and_idle_state() {
        for action in [
            Action::AnswerContact {
                room_id: ROOM.into(),
            },
            Action::DeclineContact {
                room_id: ROOM.into(),
            },
        ] {
            let mut state = published();
            let request = Request { version: 4, action };
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.incoming = Some(incoming());
            assert!(allowed_at(&state, &request, 1_999));
            assert!(!allowed_at(&state, &request, 2_000));
            state.snapshot.incoming.as_mut().unwrap().room_id = uuid::Uuid::new_v4().to_string();
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.incoming = Some(incoming());
            state.snapshot.active = true;
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.active = false;
            state.snapshot.busy = Some("answering".into());
            assert!(!allowed_at(&state, &request, 1_000));
            state.snapshot.busy = None;
            state.snapshot.connected = true;
            assert!(!allowed_at(&state, &request, 1_000));
        }
    }

    #[test]
    fn managed_invitation_and_action_wire_shapes_are_strict() {
        let token = "A".repeat(22);
        let invitation = format!("yri2_{ROOM}_{token}");
        assert!(valid_invitation(&invitation));
        assert!(valid_invitation(&format!("yri1_{token}")));
        assert!(!valid_invitation(&format!(
            "yri2_{ROOM}_{}",
            "A".repeat(23)
        )));
        assert!(!valid_invitation(&format!(
            "yri2_{}_{}",
            "あ".repeat(12),
            token
        )));
        assert!(!valid_invitation(&format!(
            "yri2_{}_{}",
            ROOM.replace("4234", "1234"),
            token
        )));
        assert!(!valid_invitation(&format!("https://host/{invitation}")));
        assert!(allowed_at(
            &published(),
            &Request {
                version: 4,
                action: Action::Join {
                    name: "より".into(),
                    invitation
                }
            },
            1_000
        ));
        for value in [
            serde_json::json!({"type":"call-contact","name":"より","identityId":ID}),
            serde_json::json!({"type":"remove-contact","identityId":ID}),
            serde_json::json!({"type":"answer-contact","roomId":ROOM}),
            serde_json::json!({"type":"decline-contact","roomId":ROOM}),
        ] {
            let action: Action = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(action).unwrap(), value);
            let mut bad = value;
            bad["invitation"] = serde_json::json!("private-token");
            assert!(serde_json::from_value::<Action>(bad).is_err());
        }
    }
}
