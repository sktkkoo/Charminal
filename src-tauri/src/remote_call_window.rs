//! A presentation-only remote resident. The main window owns the call and all audio.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN: &str = "main";
const REMOTE: &str = "auxiliary-call-resident";
const QUERY: &str = "auxiliary=call-resident";
const EVENT: &str = "remote-call-window-state";
const ACTION: &str = "remote-call-window-action";
const MAX_AVATAR_BYTES: usize = 50 * 1024 * 1024;
const MAX_SCENE_BYTES: usize = 512 * 1024;
const MAX_SCENE_DEPTH: usize = 16;
const MAX_MEDIA_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES: usize = 128 * 1024 * 1024;
const MAX_MEDIA_ITEMS: usize = 16;
const MEDIA_PREFIX: &str = "yorishiro-call-media:";

struct ResidentMedia {
    mime: String,
    bytes: Vec<u8>,
    published: bool,
}

#[derive(Serialize)]
pub struct ResidentMediaResponse {
    mime: String,
    encoded: String,
}

fn valid_media_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id)
        .is_ok_and(|value| value.get_version_num() == 4 && value.to_string() == id)
}

fn valid_media_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png"
            | "image/jpeg"
            | "image/webp"
            | "image/gif"
            | "image/bmp"
            | "image/avif"
            | "image/svg+xml"
            | "video/mp4"
            | "video/webm"
            | "video/ogg"
            | "video/quicktime"
    )
}

fn media_capacity_available(count: usize, total: usize, incoming: usize) -> bool {
    count < MAX_MEDIA_ITEMS
        && incoming > 0
        && incoming <= MAX_MEDIA_BYTES
        && total
            .checked_add(incoming)
            .is_some_and(|size| size <= MAX_TOTAL_MEDIA_BYTES)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneMetadata {
    source: Value,
    scene: Option<VisualScene>,
    controls: HashMap<String, Value>,
    renderer: SceneRenderer,
    background: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VisualScene {
    id: String,
    layers: Vec<VisualLayer>,
    ui: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisualLayer {
    id: String,
    role: Option<String>,
    src: Option<String>,
    media_type: Option<String>,
    procedural: Option<ProceduralLayer>,
    background_color: Option<String>,
    background_image: Option<String>,
    blur: Option<f64>,
    opacity: Option<f64>,
    media_offset_x: Option<f64>,
    media_offset_y: Option<f64>,
    media_scale: Option<f64>,
    media_rotation: Option<f64>,
    drop_shadow: Option<LayerShadow>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProceduralLayer {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayerShadow {
    offset_x: f64,
    offset_y: f64,
    blur: f64,
    color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneRenderer {
    tone_mapping: u32,
    tone_mapping_exposure: f64,
    output_color_space: String,
    shadow_map_enabled: bool,
    shadow_map_type: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneSource {
    origin: String,
    id: String,
    generation: Option<u64>,
}

fn validate_scene_source(value: &Value) -> Result<Option<SceneSource>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let source: SceneSource = serde_json::from_value(value.clone()).map_err(|_| scene_error())?;
    if !matches!(source.origin.as_str(), "bundled" | "user")
        || source.id.is_empty()
        || source.id.starts_with('.')
        || !visual_text(&source.id, 240)
        || source.id.contains(['/', '\\', ':'])
        || !matches!(
            Path::new(&source.id).components().next(),
            Some(Component::Normal(_))
        )
        || value.get("generation").is_some_and(|value| !value.is_u64())
        || source
            .generation
            .is_some_and(|value| value == 0 || value > 9_007_199_254_740_991)
    {
        return Err(scene_error());
    }
    Ok(Some(source))
}

/// Resolve only the scene entry selected by the main-owned snapshot. Native discovery supplies
/// provenance/manifest; the viewer must still apply the existing execution policy before import.
fn selected_scene_entry(id: &str, packs_root: &Path) -> Result<Value, String> {
    let root = packs_root.canonicalize().map_err(|_| scene_error())?;
    let pack_dir = packs_root.join(id);
    let canonical_pack = pack_dir.canonicalize().map_err(|_| scene_error())?;
    if canonical_pack.parent() != Some(root.as_path()) {
        return Err(scene_error());
    }
    let entry = crate::entry_file_for_kind(&pack_dir, "scene").ok_or_else(scene_error)?;
    let canonical_entry = entry.canonicalize().map_err(|_| scene_error())?;
    if canonical_entry.parent() != Some(canonical_pack.as_path()) {
        return Err(scene_error());
    }
    let manifest_path = pack_dir.join("manifest.json");
    if manifest_path.exists() {
        let canonical_manifest = manifest_path.canonicalize().map_err(|_| scene_error())?;
        if canonical_manifest.parent() != Some(canonical_pack.as_path())
            || std::fs::metadata(&canonical_manifest)
                .map_err(|_| scene_error())?
                .len()
                > 64 * 1024
        {
            return Err(scene_error());
        }
    }
    let modified_at = std::fs::metadata(&canonical_entry)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    let mut value = serde_json::to_value(crate::UserPackEntry {
        id: id.into(),
        kind: "scene".into(),
        entry_path: entry.to_string_lossy().into_owned(),
        source: "local",
        manifest: crate::read_user_pack_manifest_summary(&pack_dir),
    })
    .map_err(|_| scene_error())?;
    if let Some(modified_at) = modified_at {
        value["modifiedAt"] = modified_at.into();
    }
    Ok(value)
}

fn scene_error() -> String {
    "Invalid remote resident scene metadata".into()
}

fn visual_text(value: &str, limit: usize) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    value.len() <= limit
        && !value.chars().any(char::is_control)
        && !normalized.contains("javascript:")
        && !normalized.contains("<script")
        && !normalized.starts_with("data:text/html")
        && !normalized.starts_with("data:text/javascript")
        && !normalized.starts_with("data:application/javascript")
        && !normalized.starts_with("function(")
        && !normalized.starts_with("function ")
        && !normalized.contains("=>")
}

fn bounded_scene_json(value: &Value, depth: usize, remaining: &mut usize) -> bool {
    if depth > MAX_SCENE_DEPTH || *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::String(value) => visual_text(value, 64 * 1024),
        Value::Array(values) => {
            values.len() <= 1024
                && values
                    .iter()
                    .all(|value| bounded_scene_json(value, depth + 1, remaining))
        }
        Value::Object(values) => {
            values.len() <= 256
                && values.iter().all(|(key, value)| {
                    let key_kind = key.to_ascii_lowercase().replace(['_', '-'], "");
                    visual_text(key, 256)
                        && !matches!(key_kind.as_str(), "proto" | "prototype" | "constructor")
                        && bounded_scene_json(value, depth + 1, remaining)
                })
        }
    }
}

fn scene_number(value: Option<f64>, min: f64, max: f64) -> bool {
    value.is_none_or(|value| value.is_finite() && (min..=max).contains(&value))
}

struct SceneSizeLimit(usize);
impl std::io::Write for SceneSizeLimit {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_SCENE_BYTES - self.0 {
            return Err(std::io::Error::other("Scene metadata size limit"));
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn validate_scene_metadata(value: &Value) -> Result<(), String> {
    if !bounded_scene_json(value, 0, &mut 16_384)
        || serde_json::to_writer(SceneSizeLimit(0), value).is_err()
        || !value.as_object().is_some_and(|fields| {
            ["source", "scene", "controls", "renderer", "background"]
                .iter()
                .all(|key| fields.contains_key(*key))
        })
    {
        return Err(scene_error());
    }
    let metadata: SceneMetadata =
        serde_json::from_value(value.clone()).map_err(|_| scene_error())?;
    validate_scene_source(&metadata.source)?;
    if !visual_text(&metadata.background, 8192)
        || metadata.controls.len() > 256
        || metadata.renderer.tone_mapping > 16
        || !scene_number(Some(metadata.renderer.tone_mapping_exposure), 0.0, 1000.0)
        || !matches!(
            metadata.renderer.output_color_space.as_str(),
            "" | "srgb" | "srgb-linear"
        )
        || metadata.renderer.shadow_map_type > 3
    {
        return Err(scene_error());
    }
    // This field is deliberately typed even though both values are valid presentation settings.
    let _ = metadata.renderer.shadow_map_enabled;
    if let Some(scene) = metadata.scene {
        if scene.id.is_empty() || !visual_text(&scene.id, 240) || scene.layers.len() > 64 {
            return Err(scene_error());
        }
        if let Some(ui) = scene.ui {
            const FIELDS: &[&str] = &[
                "background",
                "foreground",
                "foregroundDim",
                "sidebarBackground",
                "panelBackground",
                "border",
                "buttonBackground",
                "buttonForeground",
                "inputBackground",
                "accent",
                "accentSoft",
                "accentBorder",
                "muted",
                "glow",
            ];
            if ui
                .iter()
                .any(|(key, value)| !FIELDS.contains(&key.as_str()) || !visual_text(value, 1024))
            {
                return Err(scene_error());
            }
        }
        for layer in scene.layers {
            if layer.id.is_empty()
                || !visual_text(&layer.id, 240)
                || layer
                    .role
                    .as_deref()
                    .is_some_and(|role| !matches!(role, "background" | "character" | "foreground"))
                || layer
                    .media_type
                    .as_deref()
                    .is_some_and(|kind| !matches!(kind, "image" | "video"))
                || layer
                    .src
                    .as_deref()
                    .is_some_and(|src| !visual_text(src, 8192))
                || layer
                    .background_color
                    .as_deref()
                    .is_some_and(|color| !visual_text(color, 1024))
                || layer
                    .background_image
                    .as_deref()
                    .is_some_and(|image| !visual_text(image, 8192))
                || layer
                    .procedural
                    .as_ref()
                    .is_some_and(|value| value.kind != "misty-grasslands" || layer.src.is_some())
                || !scene_number(layer.blur, 0.0, 1000.0)
                || !scene_number(layer.opacity, 0.0, 1.0)
                || !scene_number(layer.media_offset_x, -10_000.0, 10_000.0)
                || !scene_number(layer.media_offset_y, -10_000.0, 10_000.0)
                || !scene_number(layer.media_scale, 0.001, 1000.0)
                || !scene_number(layer.media_rotation, -36_000.0, 36_000.0)
                || layer.drop_shadow.as_ref().is_some_and(|shadow| {
                    !scene_number(Some(shadow.offset_x), -10_000.0, 10_000.0)
                        || !scene_number(Some(shadow.offset_y), -10_000.0, 10_000.0)
                        || !scene_number(Some(shadow.blur), 0.0, 1000.0)
                        || !visual_text(&shadow.color, 1024)
                })
            {
                return Err(scene_error());
            }
        }
    }
    Ok(())
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anchor: Option<[f64; 3]>,
}
fn default_zoom() -> f64 {
    1.0
}
fn default_visible() -> bool {
    true
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResidentFrame {
    lease_id: String,
    label: String,
    language: String,
    mode: String,
    #[serde(default = "default_visible")]
    visible: bool,
    /// Existing fixed-size, validated motion format. Never code or arbitrary expression names.
    motion: Option<Vec<u8>>,
    mouth: [f64; 5],
    camera: ResidentCamera,
    #[serde(default)]
    sequence: u64,
    #[serde(default)]
    avatar_revision: u64,
    #[serde(default)]
    scene_revision: u64,
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
            || self
                .camera
                .anchor
                .is_some_and(|anchor| anchor.iter().any(|v| !v.is_finite() || v.abs() > 100.0))
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
    scene: Option<Value>,
    scene_revision: u64,
    source_revision: u64,
    scene_entry: Option<Value>,
    media: HashMap<String, ResidentMedia>,
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
    fn require_show(&self, label: &str, lease: &str) -> Result<(), String> {
        require_label(label, MAIN)?;
        self.require_lease(lease)?;
        if self.opening || self.closing {
            return Err("Remote resident view is changing".into());
        }
        Ok(())
    }
    fn clear(&mut self) -> Option<String> {
        self.frame = None;
        self.avatar = None;
        self.avatar_revision = 0;
        self.scene = None;
        self.scene_revision = 0;
        self.source_revision = 0;
        self.scene_entry = None;
        self.media.clear();
        self.mode_resize_until = None;
        self.projected_size = None;
        self.lease.take()
    }
    fn set_scene(&mut self, label: &str, lease: &str, scene: Value) -> Result<u64, String> {
        require_label(label, MAIN)?;
        self.require_lease(lease)?;
        validate_scene_metadata(&scene)?;
        let mut referenced_media = HashSet::new();
        for layer in scene["scene"]["layers"].as_array().into_iter().flatten() {
            if let Some(id) = layer["src"]
                .as_str()
                .and_then(|src| src.strip_prefix(MEDIA_PREFIX))
            {
                if !valid_media_id(id) || !self.media.contains_key(id) {
                    return Err("Remote resident scene media is unavailable".into());
                }
                referenced_media.insert(id.to_owned());
            }
        }
        if self.scene.as_ref() != Some(&scene) {
            let next_revision = self.scene_revision.checked_add(1).ok_or_else(scene_error)?;
            if self.scene.as_ref().map(|value| &value["source"]) != Some(&scene["source"]) {
                self.scene_entry = None;
                self.source_revision = next_revision;
            }
            self.scene_revision = next_revision;
            self.scene = Some(scene);
            self.media.retain(|id, media| {
                if referenced_media.contains(id) {
                    media.published = true;
                    true
                } else {
                    // An unrelated controls upload can precede the first snapshot that uses
                    // newly uploaded bytes. Keep pending uploads within the fixed cache bounds.
                    !media.published
                }
            });
        }
        Ok(self.scene_revision)
    }
    fn read_scene(&self, label: &str, lease: &str, revision: u64) -> Result<Option<Value>, String> {
        require_label(label, REMOTE)?;
        self.require_lease(lease)?;
        if revision != self.scene_revision {
            return Err("Remote resident scene has changed".into());
        }
        Ok(self.scene.clone())
    }
    fn read_scene_entry(
        &mut self,
        label: &str,
        lease: &str,
        revision: u64,
        packs_root: &Path,
    ) -> Result<Option<Value>, String> {
        require_label(label, REMOTE)?;
        self.require_lease(lease)?;
        // Controls may change while the viewer imports this same scene. Only a source/HMR
        // change invalidates the selected entry; an old source can never borrow the new one.
        if revision < self.source_revision || revision > self.scene_revision {
            return Err("Remote resident scene has changed".into());
        }
        let Some(scene) = self.scene.as_ref() else {
            return Ok(None);
        };
        let Some(source) = validate_scene_source(&scene["source"])? else {
            return Ok(None);
        };
        if source.origin != "user" {
            return Ok(None);
        }
        if self.scene_entry.is_none() {
            self.scene_entry = Some(selected_scene_entry(&source.id, packs_root)?);
        }
        Ok(self.scene_entry.clone())
    }
    fn set_media(
        &mut self,
        label: &str,
        lease: &str,
        id: String,
        mime: String,
        encoded: &str,
    ) -> Result<(), String> {
        require_label(label, MAIN)?;
        self.require_lease(lease)?;
        if !valid_media_id(&id)
            || !valid_media_mime(&mime)
            || encoded.len() > MAX_MEDIA_BYTES.div_ceil(3) * 4
        {
            return Err("Invalid remote resident scene media".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid remote resident scene media encoding")?;
        if let Some(existing) = self.media.get(&id) {
            return if existing.mime == mime && existing.bytes == bytes {
                Ok(())
            } else {
                Err("Remote resident scene media IDs are immutable".into())
            };
        }
        let total = self.media.values().map(|media| media.bytes.len()).sum();
        if !media_capacity_available(self.media.len(), total, bytes.len()) {
            return Err("Remote resident scene media exceeded its size or count limit".into());
        }
        self.media.insert(
            id,
            ResidentMedia {
                mime,
                bytes,
                published: false,
            },
        );
        Ok(())
    }
    fn read_media(
        &self,
        label: &str,
        lease: &str,
        id: &str,
    ) -> Result<ResidentMediaResponse, String> {
        require_label(label, REMOTE)?;
        self.require_lease(lease)?;
        if !valid_media_id(id) {
            return Err("Invalid remote resident scene media ID".into());
        }
        let media = self
            .media
            .get(id)
            .ok_or("Remote resident scene media is unavailable")?;
        Ok(ResidentMediaResponse {
            mime: media.mime.clone(),
            encoded: STANDARD.encode(&media.bytes),
        })
    }
    fn stamp_frame(&mut self, frame: &mut ResidentFrame) {
        self.sequence = self.sequence.saturating_add(1);
        frame.sequence = self.sequence;
        frame.avatar_revision = self.avatar_revision;
        frame.scene_revision = self.scene_revision;
    }
    fn begin_mode_resize(&mut self, size: tauri::PhysicalSize<u32>, now: Instant) {
        self.mode_resize_until = Some(now + Duration::from_secs(1));
        self.projected_size = Some(size);
    }
    fn finish_opening(
        &mut self,
        lease: &str,
        built: bool,
        main_size: Option<tauri::PhysicalSize<u32>>,
        now: Instant,
    ) -> (bool, Option<tauri::PhysicalSize<u32>>) {
        self.opening = false;
        let cancelled = self.require_lease(lease).is_err();
        self.closing = cancelled && built;
        let size = main_size.filter(|_| built && !cancelled);
        if let Some(size) = size {
            self.begin_mode_resize(size, now);
        }
        (cancelled, size)
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

/// Keep the resident on the left and the peer on the right, moving main only as far
/// as needed to fit both inside the monitor's usable area. A still-resizing Terminal
/// window may be too wide; defer placement until its compact format has settled.
fn resident_pair_positions(
    position: tauri::PhysicalPosition<i32>,
    main_size: tauri::PhysicalSize<u32>,
    remote_size: tauri::PhysicalSize<u32>,
    area: tauri::PhysicalRect<i32, u32>,
    gap: u32,
) -> Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalPosition<i32>)> {
    let width = i64::from(main_size.width) + i64::from(gap) + i64::from(remote_size.width);
    let height = main_size.height.max(remote_size.height);
    if width > i64::from(area.size.width) || height > area.size.height {
        return None;
    }
    let left = i64::from(area.position.x);
    let top = i64::from(area.position.y);
    let x = i64::from(position.x).clamp(left, left + i64::from(area.size.width) - width);
    let y = i64::from(position.y).clamp(top, top + i64::from(area.size.height - height));
    let peer_x = x + i64::from(main_size.width) + i64::from(gap);
    Some((
        tauri::PhysicalPosition::new(i32::try_from(x).ok()?, i32::try_from(y).ok()?),
        tauri::PhysicalPosition::new(i32::try_from(peer_x).ok()?, i32::try_from(y).ok()?),
    ))
}

fn arrange_resident_pair(window: &WebviewWindow, remote: &WebviewWindow) {
    let (Ok(position), Ok(main_size), Ok(remote_size), Ok(Some(monitor))) = (
        window.outer_position(),
        window.outer_size(),
        remote.outer_size(),
        window.current_monitor(),
    ) else {
        return;
    };
    let gap = (12.0 * window.scale_factor().unwrap_or(1.0)).round() as u32;
    if let Some((main_position, remote_position)) =
        resident_pair_positions(position, main_size, remote_size, *monitor.work_area(), gap)
    {
        if main_position != position {
            let _ = window.set_position(main_position);
        }
        let _ = remote.set_position(remote_position);
    }
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
    // Match the current native format, then arrange the pair once both sizes are known.
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
    // A view pack can finish resizing main while this WebView is being built. Re-read
    // its geometry, then follow the same brief transition as an existing view-mode switch.
    let current_main_size = built.as_ref().ok().and_then(|_| window.inner_size().ok());
    let (cancelled, resize, visible) = {
        let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
        let (cancelled, resize) =
            state.finish_opening(&lease_id, built.is_ok(), current_main_size, Instant::now());
        let visible = state.frame.as_ref().is_none_or(|frame| frame.visible);
        if !visible {
            state.mode_resize_until = None;
        }
        (cancelled, resize, visible)
    };
    let built = built.map_err(|e| e.to_string())?;
    if cancelled {
        built.destroy().map_err(|e| e.to_string())?;
        return Err("Remote resident view was cancelled".into());
    }
    if let Some(size) = resize {
        let _ = built.set_size(size);
    }
    if visible {
        arrange_resident_pair(&window, &built);
    } else {
        let _ = built.hide();
    }
    Ok(())
}

/// Only an explicit main-window action reveals the existing presentation; automatic creation
/// deliberately keeps focus in main. Capture the lease-owned handle before platform callbacks.
#[tauri::command]
pub fn remote_call_window_show(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
) -> Result<(), String> {
    let resident = {
        let state = state.0.lock().map_err(|_| "Resident state unavailable")?;
        state.require_show(window.label(), &lease_id)?;
        app.get_webview_window(REMOTE)
            .ok_or("Remote resident window is unavailable")?
    };
    resident.unminimize().map_err(|error| error.to_string())?;
    resident.show().map_err(|error| error.to_string())?;
    resident.set_focus().map_err(|error| error.to_string())
}

fn decode_avatar(encoded: &str) -> Result<Vec<u8>, String> {
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
    Ok(bytes)
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
    let bytes = decode_avatar(&encoded)?;
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

/// Only the main window's selected local appearance is projected. This never carries code,
/// audio, resident instructions, or a scene selected by the remote call participant.
#[tauri::command]
pub fn remote_call_window_scene(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
    scene: Value,
) -> Result<u64, String> {
    require_label(window.label(), MAIN)?;
    let mut state = state.0.lock().map_err(|_| "Resident state unavailable")?;
    state.require_lease(&lease_id)?;
    state.set_scene(window.label(), &lease_id, scene)
}

#[tauri::command]
pub fn remote_call_window_read_scene(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
    revision: u64,
) -> Result<Option<Value>, String> {
    require_label(window.label(), REMOTE)?;
    state
        .0
        .lock()
        .map_err(|_| "Resident state unavailable")?
        .read_scene(window.label(), &lease_id, revision)
}

#[tauri::command]
pub fn remote_call_window_scene_entry(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
    scene_revision: u64,
) -> Result<Option<Value>, String> {
    require_label(window.label(), REMOTE)?;
    state
        .0
        .lock()
        .map_err(|_| "Resident state unavailable")?
        .read_scene_entry(
            window.label(),
            &lease_id,
            scene_revision,
            &crate::yorishiro_home_path()?.join("packs"),
        )
}

/// Borrowed main-window Blob media becomes immutable bytes scoped to this presentation lease.
/// The auxiliary viewer creates its own image/video Blob URL; no path or executable MIME is accepted.
#[tauri::command]
pub fn remote_call_window_media(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
    id: String,
    mime: String,
    encoded: String,
) -> Result<(), String> {
    require_label(window.label(), MAIN)?;
    state
        .0
        .lock()
        .map_err(|_| "Resident state unavailable")?
        .set_media(window.label(), &lease_id, id, mime, &encoded)
}

#[tauri::command]
pub fn remote_call_window_read_media(
    window: WebviewWindow,
    state: State<'_, RemoteCallWindowState>,
    lease_id: String,
    id: String,
) -> Result<ResidentMediaResponse, String> {
    require_label(window.label(), REMOTE)?;
    state
        .0
        .lock()
        .map_err(|_| "Resident state unavailable")?
        .read_media(window.label(), &lease_id, &id)
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
    let visibility_changed = state
        .frame
        .as_ref()
        .map_or(!frame.visible, |previous| previous.visible != frame.visible);
    state.stamp_frame(&mut frame);
    let lease = frame.lease_id.clone();
    let mode = frame.mode.clone();
    let visible = frame.visible;
    if !visible {
        state.mode_resize_until = None;
    }
    state.frame = Some(frame.clone());
    app.emit_to(REMOTE, EVENT, frame)
        .map_err(|e| e.to_string())?;
    drop(state);
    if visible && (mode_changed || visibility_changed) {
        if let Some(remote) = app.get_webview_window(REMOTE) {
            // Call/Portrait are the same existing native formats after a view-mode switch.
            if let Ok(size) = window.inner_size() {
                let resident_state = app.state::<RemoteCallWindowState>();
                let mut state = resident_state
                    .0
                    .lock()
                    .map_err(|_| "Resident state unavailable")?;
                if state.require_lease(&lease).is_err()
                    || state.frame.as_ref().is_none_or(|frame| frame.mode != mode)
                {
                    return Ok(());
                }
                state.begin_mode_resize(size, Instant::now());
                drop(state);
                let _ = remote.set_size(size);
                arrange_resident_pair(&window, &remote);
            }
            if let Ok(on_top) = window.is_always_on_top() {
                let _ = remote.set_always_on_top(on_top);
            }
            // Mode switches reveal the retained viewer without stealing focus from main.
            if visibility_changed {
                let _ = remote.show();
            }
        }
    } else if !visible && visibility_changed {
        if let Some(remote) = app.get_webview_window(REMOTE) {
            let _ = remote.hide();
        }
    }
    Ok(())
}

/// Existing view packs resize the main window asynchronously. Follow only the short
/// opening/mode-change transition; ordinary later resizing of either window stays independent.
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
            if let Some(main) = app.get_webview_window(MAIN) {
                arrange_resident_pair(&main, &remote);
            }
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
    fn avatar_decode_accepts_50_mib_and_rejects_larger_payloads() {
        for size in [50 * 1024 * 1024, 50 * 1024 * 1024 + 1] {
            let mut bytes = vec![0_u8; size];
            bytes[..4].copy_from_slice(b"glTF");
            bytes[4..8].copy_from_slice(&2_u32.to_le_bytes());
            bytes[8..12].copy_from_slice(&(size as u32).to_le_bytes());
            assert_eq!(
                decode_avatar(&STANDARD.encode(bytes)).is_ok(),
                size <= MAX_AVATAR_BYTES
            );
        }
        let too_long = "A".repeat(MAX_AVATAR_BYTES.div_ceil(3) * 4 + 1);
        assert_eq!(
            decode_avatar(&too_long).unwrap_err(),
            "Remote avatar is too large"
        );
    }

    fn scene_metadata() -> Value {
        serde_json::json!({
            "source": {"origin": "bundled", "id": "simple-room", "generation": 1},
            "scene": {"id": "simple-room", "layers": [
                {"id": "background", "role": "background", "backgroundColor": "#123456"},
                {"id": "character", "role": "character", "opacity": 1.0}
            ], "ui": {"background": "#123456"}},
            "controls": {"lighting.intensity": 1.0, "sky": {"color": "#abc", "position": [0, 1, 2]}},
            "renderer": {"toneMapping": 4, "toneMappingExposure": 1.0, "outputColorSpace": "srgb", "shadowMapEnabled": true, "shadowMapType": 2},
            "background": "#123456"
        })
    }
    fn scene_state() -> ResidentState {
        ResidentState {
            lease: Some("lease".into()),
            ..Default::default()
        }
    }
    #[test]
    fn only_the_current_main_owner_can_reveal_a_settled_remote_window() {
        let mut state = scene_state();
        assert!(state.require_show(MAIN, "lease").is_ok());
        assert!(state.require_show(REMOTE, "lease").is_err());
        assert!(state
            .require_show("auxiliary-camera-preview", "lease")
            .is_err());
        assert!(state.require_show(MAIN, "previous").is_err());
        state.opening = true;
        assert!(state.require_show(MAIN, "lease").is_err());
        state.opening = false;
        state.closing = true;
        assert!(state.require_show(MAIN, "lease").is_err());
        state.closing = false;
        state.clear();
        assert!(state.require_show(MAIN, "lease").is_err());
    }
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
    fn upload_image(state: &mut ResidentState, id: &str) -> Result<(), String> {
        state.set_media(MAIN, "lease", id.into(), "image/png".into(), PNG)
    }
    #[test]
    fn media_bytes_are_immutable_main_owned_and_lease_scoped() {
        let mut state = scene_state();
        let id = uuid::Uuid::new_v4().to_string();
        for label in [REMOTE, "auxiliary-camera-preview"] {
            assert!(state
                .set_media(label, "lease", id.clone(), "image/png".into(), PNG)
                .is_err());
        }
        assert!(state
            .set_media(MAIN, "old", id.clone(), "image/png".into(), PNG)
            .is_err());
        upload_image(&mut state, &id).unwrap();
        upload_image(&mut state, &id).unwrap();
        assert_eq!(state.media.len(), 1);
        let media = state.read_media(REMOTE, "lease", &id).unwrap();
        assert_eq!(media.mime, "image/png");
        assert_eq!(
            STANDARD.decode(media.encoded).unwrap(),
            STANDARD.decode(PNG).unwrap()
        );
        assert!(state.read_media(MAIN, "lease", &id).is_err());
        assert!(state
            .read_media("auxiliary-camera-preview", "lease", &id)
            .is_err());
        assert!(state.read_media(REMOTE, "old", &id).is_err());
        assert!(state
            .set_media(MAIN, "lease", id.clone(), "image/webp".into(), PNG)
            .is_err());
        assert!(state
            .set_media(MAIN, "lease", id.clone(), "image/png".into(), "YWJj")
            .is_err());
        state.clear();
        state.lease = Some("next".into());
        assert!(state.media.is_empty());
        assert!(state.read_media(REMOTE, "lease", &id).is_err());
        assert!(state.read_media(REMOTE, "next", &id).is_err());
    }
    #[test]
    fn media_rejects_paths_executable_mime_invalid_encoding_and_capacity_overflow() {
        let mut state = scene_state();
        for id in [
            "../image.png",
            "file:///image.png",
            "00000000-0000-0000-0000-000000000000",
            "FCD7CFB8-86F5-49F8-A462-9587CFF07DD0",
        ] {
            assert!(upload_image(&mut state, id).is_err());
            assert!(state.read_media(REMOTE, "lease", id).is_err());
        }
        for mime in [
            "text/html",
            "text/javascript",
            "application/javascript",
            "application/octet-stream",
            "audio/ogg",
            "image/svg+xml;charset=utf-8",
        ] {
            assert!(state
                .set_media(
                    MAIN,
                    "lease",
                    uuid::Uuid::new_v4().to_string(),
                    mime.into(),
                    PNG
                )
                .is_err());
        }
        for encoded in ["", "not-base64!"] {
            assert!(state
                .set_media(
                    MAIN,
                    "lease",
                    uuid::Uuid::new_v4().to_string(),
                    "image/png".into(),
                    encoded
                )
                .is_err());
        }
        assert!(valid_media_mime("image/svg+xml"));
        assert!(valid_media_mime("video/quicktime"));
        assert!(media_capacity_available(0, 0, MAX_MEDIA_BYTES));
        assert!(media_capacity_available(
            1,
            MAX_MEDIA_BYTES,
            MAX_MEDIA_BYTES
        ));
        assert!(!media_capacity_available(0, 0, MAX_MEDIA_BYTES + 1));
        assert!(!media_capacity_available(2, MAX_TOTAL_MEDIA_BYTES, 1));
        assert!(!media_capacity_available(0, usize::MAX, 1));
        assert!(!media_capacity_available(0, 0, 0));
        assert!(!media_capacity_available(MAX_MEDIA_ITEMS, 0, 1));
        for _ in 0..MAX_MEDIA_ITEMS {
            upload_image(&mut state, &uuid::Uuid::new_v4().to_string()).unwrap();
        }
        assert!(upload_image(&mut state, &uuid::Uuid::new_v4().to_string()).is_err());
        assert_eq!(state.media.len(), MAX_MEDIA_ITEMS);
    }
    #[test]
    fn scene_media_prunes_published_assets_but_preserves_pending_uploads() {
        let mut state = scene_state();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        upload_image(&mut state, &first).unwrap();
        let mut scene = scene_metadata();
        state.set_scene(MAIN, "lease", scene.clone()).unwrap();
        assert!(!state.media[&first].published);
        scene["scene"]["layers"][0]["src"] = format!("{MEDIA_PREFIX}{first}").into();
        state.set_scene(MAIN, "lease", scene.clone()).unwrap();
        assert!(state.media[&first].published);
        upload_image(&mut state, &second).unwrap();
        scene["controls"]["lighting.intensity"] = 2.into();
        state.set_scene(MAIN, "lease", scene.clone()).unwrap();
        assert!(!state.media[&second].published);
        assert!(state.read_media(REMOTE, "lease", &first).is_ok());
        scene["scene"]["layers"][0]["src"] = format!("{MEDIA_PREFIX}{second}").into();
        state.set_scene(MAIN, "lease", scene.clone()).unwrap();
        assert!(state.read_media(REMOTE, "lease", &first).is_err());
        assert!(state.media[&second].published);
        let revision = state.scene_revision;
        scene["scene"]["layers"][0]["src"] = format!("{MEDIA_PREFIX}{first}").into();
        assert!(state.set_scene(MAIN, "lease", scene).is_err());
        assert_eq!(state.scene_revision, revision);
        assert_eq!(state.media.len(), 1);
        state.set_scene(MAIN, "lease", scene_metadata()).unwrap();
        assert!(state.media.is_empty());
    }
    #[test]
    fn scenes_are_main_owned_and_reads_require_the_exact_lease_and_revision() {
        let mut state = scene_state();
        assert_eq!(state.read_scene(REMOTE, "lease", 0).unwrap(), None);
        assert!(state.set_scene(REMOTE, "lease", scene_metadata()).is_err());
        assert!(state
            .set_scene("auxiliary-camera-preview", "lease", scene_metadata())
            .is_err());
        assert!(state.set_scene(MAIN, "old", scene_metadata()).is_err());
        assert_eq!(state.set_scene(MAIN, "lease", scene_metadata()).unwrap(), 1);
        assert_eq!(state.set_scene(MAIN, "lease", scene_metadata()).unwrap(), 1);
        assert_eq!(
            state.read_scene(REMOTE, "lease", 1).unwrap(),
            Some(scene_metadata())
        );
        assert!(state.read_scene(MAIN, "lease", 1).is_err());
        assert!(state.read_scene(REMOTE, "old", 1).is_err());
        assert!(state.read_scene(REMOTE, "lease", 0).is_err());
        let mut next = scene_metadata();
        next["controls"]["lighting.intensity"] = 2.into();
        assert_eq!(state.set_scene(MAIN, "lease", next).unwrap(), 2);
        assert!(state.read_scene(REMOTE, "lease", 1).is_err());
        state.clear();
        state.lease = Some("new".into());
        assert_eq!(state.scene_revision, 0);
        assert_eq!(state.source_revision, 0);
        assert!(state.scene_entry.is_none());
        assert_eq!(state.read_scene(REMOTE, "new", 0).unwrap(), None);
        assert!(state.read_scene(REMOTE, "lease", 2).is_err());
    }
    #[test]
    fn frame_revisions_are_native_stamped_and_legacy_frames_default_to_zero() {
        let mut state = scene_state();
        state.set_scene(MAIN, "lease", scene_metadata()).unwrap();
        let mut current = frame();
        current.scene_revision = 12345;
        state.stamp_frame(&mut current);
        assert_eq!(current.scene_revision, 1);
        assert_eq!(current.sequence, 1);
        let mut legacy = serde_json::to_value(frame()).unwrap();
        legacy.as_object_mut().unwrap().remove("sceneRevision");
        assert_eq!(
            serde_json::from_value::<ResidentFrame>(legacy)
                .unwrap()
                .scene_revision,
            0
        );
    }
    #[test]
    fn scene_schema_rejects_executable_private_audio_and_unknown_fields() {
        assert!(validate_scene_metadata(&scene_metadata()).is_ok());
        for field in ["ambient", "terminal", "context", "script", "component"] {
            let mut value = scene_metadata();
            value["scene"][field] = serde_json::json!([]);
            assert!(
                validate_scene_metadata(&value).is_err(),
                "accepted scene field {field}"
            );
        }
        for field in ["__proto__", "prototype", "constructor"] {
            let mut value = scene_metadata();
            value["controls"][field] = serde_json::json!({"value": 1});
            assert!(
                validate_scene_metadata(&value).is_err(),
                "accepted controls field {field}"
            );
        }
        // Control names are inert local scene knobs, including ambient-light and code labels.
        for field in ["ambient", "audio", "context", "history", "code"] {
            let mut value = scene_metadata();
            value["controls"][field] = 0.5.into();
            assert!(validate_scene_metadata(&value).is_ok());
        }
        let mut value = scene_metadata();
        value["privateContext"] = "secret".into();
        assert!(validate_scene_metadata(&value).is_err());
        let mut value = scene_metadata();
        value["scene"]["layers"][0]["onClick"] = "execute".into();
        assert!(validate_scene_metadata(&value).is_err());
        for script in [
            "javascript:alert(1)",
            "function () { return 1; }",
            "() => 1",
            "<script>run()</script>",
        ] {
            let mut value = scene_metadata();
            value["controls"]["unknown"] = script.into();
            assert!(validate_scene_metadata(&value).is_err());
        }
        let mut value = scene_metadata();
        value["renderer"]["toneMappingExposure"] = (-1).into();
        assert!(validate_scene_metadata(&value).is_err());
        let mut value = scene_metadata();
        value["scene"]["layers"][0]["opacity"] = 2.into();
        assert!(validate_scene_metadata(&value).is_err());
        let mut value = scene_metadata();
        value.as_object_mut().unwrap().remove("source");
        assert!(validate_scene_metadata(&value).is_err());
    }
    #[test]
    fn scene_metadata_has_bounded_bytes_depth_and_collection_sizes() {
        let mut value = scene_metadata();
        value["controls"]["large"] = serde_json::json!(vec!["x".repeat(64 * 1024); 9]);
        assert!(validate_scene_metadata(&value).is_err());
        let mut value = scene_metadata();
        let mut nested = Value::Null;
        for _ in 0..MAX_SCENE_DEPTH {
            nested = serde_json::json!([nested]);
        }
        value["controls"]["nested"] = nested;
        assert!(validate_scene_metadata(&value).is_err());
        let mut value = scene_metadata();
        value["controls"]["large"] = serde_json::json!(vec![0; 1025]);
        assert!(validate_scene_metadata(&value).is_err());
        let mut value = scene_metadata();
        value["controls"] = Value::Object(
            (0..257)
                .map(|i| (format!("control-{i}"), Value::Null))
                .collect(),
        );
        assert!(validate_scene_metadata(&value).is_err());
        let mut state = scene_state();
        assert!(state.set_scene(MAIN, "lease", value).is_err());
        assert_eq!(state.scene_revision, 0);
        assert!(state.scene.is_none());
    }
    #[test]
    fn scene_sources_are_local_identifiers_without_import_paths_or_remote_origins() {
        for source in [
            serde_json::json!({"origin":"peer","id":"room"}),
            serde_json::json!({"origin":"user","id":"../room"}),
            serde_json::json!({"origin":"user","id":"room/scene.js"}),
            serde_json::json!({"origin":"user","id":"room\\scene.js"}),
            serde_json::json!({"origin":"user","id":"https://example.com/scene.js"}),
            serde_json::json!({"origin":"user","id":"room","entryPath":"/tmp/scene.js"}),
            serde_json::json!({"origin":"user","id":"room","generation":0}),
            serde_json::json!({"origin":"user","id":"room","generation":null}),
            serde_json::json!({"origin":"user","id":"room","generation":1.5}),
        ] {
            let mut value = scene_metadata();
            value["source"] = source;
            assert!(validate_scene_metadata(&value).is_err());
        }
    }
    #[test]
    fn selected_scene_entry_is_native_derived_and_cached_until_source_changes() {
        let directory = tempfile::tempdir().unwrap();
        let packs = directory.path().join("packs");
        let pack = packs.join("local-room");
        std::fs::create_dir_all(&pack).unwrap();
        let entry = pack.join("scene.tsx");
        std::fs::write(&entry, "export default {};").unwrap();
        std::fs::write(pack.join("manifest.json"), r#"{"id":"local-room","type":"scene","entry":"scene.tsx","executionClass":"trusted-main-thread-js"}"#).unwrap();
        let mut state = scene_state();
        let mut scene = scene_metadata();
        scene["source"] = serde_json::json!({"origin":"user","id":"local-room","generation":1});
        state.set_scene(MAIN, "lease", scene.clone()).unwrap();
        assert!(state.read_scene_entry(MAIN, "lease", 1, &packs).is_err());
        assert!(state.read_scene_entry(REMOTE, "old", 1, &packs).is_err());
        assert!(state.read_scene_entry(REMOTE, "lease", 0, &packs).is_err());
        let loaded = state
            .read_scene_entry(REMOTE, "lease", 1, &packs)
            .unwrap()
            .unwrap();
        assert_eq!(loaded["id"], "local-room");
        assert_eq!(loaded["kind"], "scene");
        assert_eq!(loaded["source"], "local");
        assert_eq!(loaded["entryPath"], entry.to_str().unwrap());
        assert_eq!(
            loaded["manifest"]["executionClass"],
            "trusted-main-thread-js"
        );
        assert!(loaded["modifiedAt"].is_u64());
        std::fs::remove_file(&entry).unwrap();
        scene["controls"]["lighting.intensity"] = 3.into();
        state.set_scene(MAIN, "lease", scene.clone()).unwrap();
        assert_eq!(state.source_revision, 1);
        assert_eq!(
            state.read_scene_entry(REMOTE, "lease", 1, &packs).unwrap(),
            Some(loaded.clone())
        );
        assert!(state.read_scene(REMOTE, "lease", 1).is_err());
        assert_eq!(
            state.read_scene_entry(REMOTE, "lease", 2, &packs).unwrap(),
            Some(loaded)
        );
        scene["source"]["generation"] = 2.into();
        state.set_scene(MAIN, "lease", scene).unwrap();
        assert_eq!(state.source_revision, 3);
        assert!(state.scene_entry.is_none());
        assert!(state.read_scene_entry(REMOTE, "lease", 2, &packs).is_err());
        assert!(state.read_scene_entry(REMOTE, "lease", 4, &packs).is_err());
        assert!(state.read_scene_entry(REMOTE, "lease", 3, &packs).is_err());
        state.set_scene(MAIN, "lease", scene_metadata()).unwrap();
        assert_eq!(
            state.read_scene_entry(REMOTE, "lease", 4, &packs).unwrap(),
            None
        );
    }
    #[cfg(unix)]
    #[test]
    fn selected_scene_entries_reject_pack_entry_and_manifest_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let packs = directory.path().join("packs");
        let external = directory.path().join("external");
        std::fs::create_dir_all(&packs).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("scene.js"), "export default {};").unwrap();
        symlink(&external, packs.join("escaped-pack")).unwrap();
        assert!(selected_scene_entry("escaped-pack", &packs).is_err());
        let pack = packs.join("room");
        std::fs::create_dir_all(&pack).unwrap();
        symlink(external.join("scene.js"), pack.join("scene.js")).unwrap();
        assert!(selected_scene_entry("room", &packs).is_err());
        std::fs::remove_file(pack.join("scene.js")).unwrap();
        std::fs::write(pack.join("scene.js"), "export default {};").unwrap();
        std::fs::write(external.join("manifest.json"), "{}").unwrap();
        symlink(external.join("manifest.json"), pack.join("manifest.json")).unwrap();
        assert!(selected_scene_entry("room", &packs).is_err());
    }
    #[test]
    fn resident_pair_uses_work_area_and_keeps_main_left_of_peer() {
        let area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(-2560, 50),
            size: tauri::PhysicalSize::new(2560, 1450),
        };
        let size = tauri::PhysicalSize::new(560, 1120);
        let pair = resident_pair_positions(
            tauri::PhysicalPosition::new(-600, 900),
            size,
            size,
            area,
            24,
        )
        .unwrap();
        assert_eq!(pair.0, tauri::PhysicalPosition::new(-1144, 380));
        assert_eq!(pair.1, tauri::PhysicalPosition::new(-560, 380));
        let pair = resident_pair_positions(
            tauri::PhysicalPosition::new(-3000, -20),
            size,
            size,
            area,
            24,
        )
        .unwrap();
        assert_eq!(pair.0, tauri::PhysicalPosition::new(-2560, 50));
        assert_eq!(pair.1, tauri::PhysicalPosition::new(-1976, 50));
        let pair = resident_pair_positions(
            tauri::PhysicalPosition::new(-2200, 100),
            size,
            size,
            area,
            24,
        )
        .unwrap();
        assert_eq!(pair.0, tauri::PhysicalPosition::new(-2200, 100));
        assert_eq!(pair.1, tauri::PhysicalPosition::new(-1616, 100));
        // Do not move main for the temporary Terminal geometry before compact sizing.
        assert!(resident_pair_positions(
            pair.0,
            tauri::PhysicalSize::new(2400, 1200),
            size,
            area,
            24,
        )
        .is_none());
    }
    #[test]
    fn initial_open_follows_main_view_resize_and_preserves_manual_remote_size() {
        let terminal_size = tauri::PhysicalSize::new(1800, 1200);
        let call_size = tauri::PhysicalSize::new(400, 600);
        let manual_size = tauri::PhysicalSize::new(480, 720);
        let now = Instant::now();
        let mut state = ResidentState {
            lease: Some("lease".into()),
            opening: true,
            ..Default::default()
        };
        // The initial frame has no previous mode to trigger publish's mode-change path.
        // Main may still have its Terminal dimensions when the new peer window opens.
        state.frame = Some(frame());
        assert_eq!(
            state.finish_opening("lease", true, Some(terminal_size), now),
            (false, Some(terminal_size))
        );
        assert!(!state.opening);
        assert_eq!(state.resized(REMOTE, terminal_size, now), None);
        assert_eq!(
            state.resized(MAIN, call_size, now + Duration::from_millis(300)),
            Some(call_size)
        );
        assert_eq!(
            state.resized(REMOTE, call_size, now + Duration::from_millis(301)),
            None
        );
        state.resized(REMOTE, manual_size, now + Duration::from_millis(400));
        assert_eq!(
            state.resized(MAIN, call_size, now + Duration::from_millis(500)),
            None
        );

        // If main finished resizing during WebView construction, opening immediately
        // projects that latest size instead of the builder's stale Terminal geometry.
        state.opening = true;
        assert_eq!(
            state.finish_opening("lease", true, Some(call_size), now),
            (false, Some(call_size))
        );
        assert_eq!(
            state.resized(MAIN, terminal_size, now + Duration::from_secs(2)),
            None
        );
        state.clear();
        state.opening = true;
        assert_eq!(
            state.finish_opening("lease", true, Some(call_size), now),
            (true, None)
        );
        assert_eq!(state.resized(MAIN, call_size, now), None);
    }
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
            visible: true,
            motion: Some(vec![0; 505]),
            mouth: [0.0; 5],
            sequence: 0,
            avatar_revision: 0,
            scene_revision: 0,
            camera: ResidentCamera {
                position: [0.0, 1.5, 0.84],
                quaternion: [0.0, 0.0, 0.0, 1.0],
                fov: 35.0,
                zoom: 1.0,
                near: 0.1,
                far: 20.0,
                anchor_y: 1.5,
                anchor: None,
            },
        }
    }
    #[test]
    fn public_projection_schema_bounds_motion_camera_and_names() {
        assert!(frame().validate().is_ok());
        let legacy = serde_json::to_value(frame()).unwrap();
        assert!(legacy["camera"].get("anchor").is_none());
        let legacy: ResidentFrame = serde_json::from_value(legacy).unwrap();
        assert!(legacy.camera.anchor.is_none());
        assert!(legacy.validate().is_ok());
        let mut anchored = frame();
        anchored.camera.anchor = Some([0.2, 1.5, -0.3]);
        let anchored: ResidentFrame =
            serde_json::from_value(serde_json::to_value(anchored).unwrap()).unwrap();
        assert_eq!(anchored.camera.anchor, Some([0.2, 1.5, -0.3]));
        assert!(anchored.validate().is_ok());
        for axis in 0..3 {
            for invalid in [f64::NAN, f64::INFINITY, -100.01, 100.01] {
                let mut value = frame();
                let mut anchor = [0.0, 1.5, 0.0];
                anchor[axis] = invalid;
                value.camera.anchor = Some(anchor);
                assert!(value.validate().is_err());
            }
        }
        let mut malformed = serde_json::to_value(frame()).unwrap();
        malformed["camera"]["anchor"] = serde_json::json!([0.0, 1.5]);
        assert!(serde_json::from_value::<ResidentFrame>(malformed).is_err());
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
