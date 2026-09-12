//! Validated, immutable selection bound to a native sharing lease.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenCaptureRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub display_width: f64,
    pub display_height: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ScreenCaptureSelection {
    #[default]
    Display,
    Window,
    Region {
        region: ScreenCaptureRegion,
    },
}

impl ScreenCaptureSelection {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Region { region } => {
                region.validate_display(region.display_width, region.display_height)
            }
            _ => Ok(()),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Display => "display",
            Self::Window => "window",
            Self::Region { .. } => "region",
        }
    }

    pub fn supports_pointers(&self) -> bool {
        matches!(self, Self::Display)
    }
}

impl ScreenCaptureRegion {
    pub fn validate_display(&self, width: f64, height: f64) -> Result<(), String> {
        if ![
            self.x,
            self.y,
            self.width,
            self.height,
            self.display_width,
            self.display_height,
            width,
            height,
        ]
        .iter()
        .all(|v| v.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width < 1.0
            || self.height < 1.0
            || width <= 0.0
            || height <= 0.0
            || self.display_width != width
            || self.display_height != height
            || self.x + self.width > width
            || self.y + self.height > height
        {
            return Err(
                "The selected region is invalid or the display changed. Select a region again."
                    .into(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn region() -> ScreenCaptureRegion {
        ScreenCaptureRegion {
            x: 20.0,
            y: 30.0,
            width: 400.0,
            height: 200.0,
            display_width: 1440.0,
            display_height: 900.0,
        }
    }
    #[test]
    fn never_expands_invalid_crops_to_full_display() {
        let valid = region();
        assert!(valid.validate_display(1440.0, 900.0).is_ok());
        assert!(valid.validate_display(900.0, 1440.0).is_err());
        for invalid in [
            ScreenCaptureRegion { x: -1.0, ..valid },
            ScreenCaptureRegion {
                width: 0.0,
                ..valid
            },
            ScreenCaptureRegion {
                width: 1440.0,
                ..valid
            },
            ScreenCaptureRegion {
                y: f64::NAN,
                ..valid
            },
            ScreenCaptureRegion {
                height: f64::INFINITY,
                ..valid
            },
        ] {
            assert!(ScreenCaptureSelection::Region { region: invalid }
                .validate()
                .is_err());
        }
    }
    #[test]
    fn cropped_and_window_images_never_grant_display_pointer_authority() {
        assert!(ScreenCaptureSelection::Display.supports_pointers());
        assert!(!ScreenCaptureSelection::Window.supports_pointers());
        assert!(!ScreenCaptureSelection::Region { region: region() }.supports_pointers());
        assert!(serde_json::from_str::<ScreenCaptureSelection>(r#"{"kind":"invalid"}"#).is_err());
        assert!(serde_json::from_str::<ScreenCaptureSelection>(r#"{"kind":"region"}"#).is_err());
    }
}
