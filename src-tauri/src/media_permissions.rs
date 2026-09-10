//! Explicit user recovery from a denied media permission. Targets are fixed, never caller URLs.
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MediaPermissionKind {
    Camera,
    Microphone,
    Screen,
}

impl MediaPermissionKind {
    #[cfg(any(target_os = "macos", test))]
    fn settings_url(self) -> &'static str {
        match self {
            Self::Camera => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
            }
            Self::Microphone => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            Self::Screen => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
        }
    }
}

fn require_controls(label: &str) -> Result<(), String> {
    match label {
        "main" | "auxiliary-screen-sharing-controls" => Ok(()),
        _ => Err("Media permission settings are only available from sharing controls".into()),
    }
}

#[tauri::command]
pub fn open_media_permission_settings(
    window: WebviewWindow,
    kind: MediaPermissionKind,
) -> Result<(), String> {
    require_controls(window.label())?;
    #[cfg(target_os = "macos")]
    {
        window
            .opener()
            .open_url(kind.settings_url(), None::<&str>)
            .map_err(|error| format!("Could not open system permission settings: {error}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("Opening media permission settings is only supported on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_targets_are_fixed_and_permission_specific() {
        for (name, suffix) in [
            ("camera", "Camera"),
            ("microphone", "Microphone"),
            ("screen", "ScreenCapture"),
        ] {
            let kind: MediaPermissionKind = serde_json::from_value(name.into()).unwrap();
            assert_eq!(
                kind.settings_url(),
                format!("x-apple.systempreferences:com.apple.preference.security?Privacy_{suffix}")
            );
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }
        for invalid in ["", "screen-recording", "https://example.com", "Camera"] {
            assert!(serde_json::from_value::<MediaPermissionKind>(invalid.into()).is_err());
        }
    }

    #[test]
    fn only_main_and_sharing_controls_can_open_settings() {
        assert!(require_controls("main").is_ok());
        assert!(require_controls("auxiliary-screen-sharing-controls").is_ok());
        for label in [
            "",
            "auxiliary-camera-preview",
            "auxiliary-screen-preview",
            "external",
        ] {
            assert!(require_controls(label).is_err());
        }
    }
}
