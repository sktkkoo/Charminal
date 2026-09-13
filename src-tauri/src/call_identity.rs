//! Managed call signing only. No command accepts arbitrary signing bytes or exports a private key.
//! The macOS backend is deliberately noninteractive; tests below never instantiate that backend.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, WebviewWindow};

#[cfg(target_os = "macos")]
mod macos;

type Result<T> = std::result::Result<T, &'static str>;
const INVALID: &str = "native-context-invalid";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    identity_id: String,
    public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authentication {
    r#type: &'static str,
    public_key: String,
    signature: String,
}

fn require_caller(label: &str, url: &tauri::Url) -> Result<()> {
    // A remote page or auxiliary webview must never gain even the fixed-format signing oracle.
    if label != "main"
        || url.scheme() != "tauri"
        || url.host_str() != Some("localhost")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(INVALID);
    }
    Ok(())
}

fn canonical_endpoint(endpoint: &str) -> Result<tauri::Url> {
    if endpoint.len() > 2048 {
        return Err(INVALID);
    }
    let url = tauri::Url::parse(endpoint).map_err(|_| INVALID)?;
    let host = url.host_str().unwrap_or("");
    let local = host == "localhost"
        || host == "[::1]"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_private());
    if url.as_str() != endpoint
        || url.path() != "/v2/rooms"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "wss" || (url.scheme() == "ws" && local))
    {
        return Err(INVALID);
    }
    Ok(url)
}

#[cfg(any(target_os = "macos", test))]
fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N]> {
    if value.len() != (N * 8).div_ceil(6) {
        return Err(INVALID);
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| INVALID)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(INVALID);
    }
    bytes.try_into().map_err(|_| INVALID)
}

#[cfg(any(target_os = "macos", test))]
fn descriptor(raw: &[u8]) -> Result<Descriptor> {
    if raw.len() != 65 || raw[0] != 4 {
        return Err("native-key-invalid");
    }
    Ok(Descriptor {
        identity_id: URL_SAFE_NO_PAD.encode(Sha256::digest(raw)),
        public_key: URL_SAFE_NO_PAD.encode(raw),
    })
}

fn scope(app_id: &str, endpoint: &str) -> Result<String> {
    canonical_endpoint(endpoint)?;
    if app_id.is_empty()
        || app_id.len() > 255
        || !app_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err(INVALID);
    }
    Ok(format!(
        "{app_id}.peer-call.p256.v1.{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(endpoint.as_bytes()))
    ))
}

#[cfg(any(target_os = "macos", test))]
fn auth_message(endpoint: &str, socket_url: &str, id: &str, challenge: &str) -> Result<Vec<u8>> {
    let origin = canonical_endpoint(endpoint)?;
    decode_fixed::<32>(id)?;
    decode_fixed::<32>(challenge)?;
    if socket_url.len() > 2200 {
        return Err(INVALID);
    }
    let url = tauri::Url::parse(socket_url).map_err(|_| INVALID)?;
    let room = url.path().strip_prefix("/v2/rooms/").is_some_and(|part| {
        uuid::Uuid::parse_str(part).is_ok_and(|id| {
            id.get_version_num() == 4
                && id.get_variant() == uuid::Variant::RFC4122
                && id.hyphenated().to_string() == part
        })
    });
    if url.as_str() != socket_url
        || url.origin() != origin.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(room || url.path() == format!("/v2/users/{id}"))
    {
        return Err(INVALID);
    }
    Ok(format!("yorishiro-call-v2\n{}\n{challenge}", url.path()).into_bytes())
}

#[cfg(any(target_os = "macos", test))]
trait KeyStore {
    type Key;
    /// Only definitive absence is None. Locked, denied, duplicate and malformed items are errors.
    fn find(&mut self, tag: &str) -> Result<Option<Self::Key>>;
    fn create(&mut self, tag: &str) -> Result<()>;
    fn public_key(&self, key: &Self::Key) -> Result<Vec<u8>>;
    fn sign(&self, key: &Self::Key, message: &[u8]) -> Result<Vec<u8>>;
}

#[cfg(any(target_os = "macos", test))]
fn prepare<S: KeyStore>(
    store: &mut S,
    tag: &str,
    expected: Option<&str>,
    allow_create: bool,
) -> Result<Descriptor> {
    if let Some(public) = expected {
        let raw = decode_fixed::<65>(public)?;
        descriptor(&raw)?;
    }
    let key = match store.find(tag)? {
        Some(key) => key,
        None if expected.is_some() || !allow_create => return Err("native-key-missing"),
        None => {
            store.create(tag)?;
            // Verify persisted attributes, not just the generation request. Never select a duplicate.
            store.find(tag)?.ok_or("native-key-missing")?
        }
    };
    let found = descriptor(&store.public_key(&key)?)?;
    if expected.is_some_and(|public| public != found.public_key) {
        return Err("native-key-mismatch");
    }
    Ok(found)
}

#[cfg(any(target_os = "macos", test))]
fn authenticate<S: KeyStore>(
    store: &mut S,
    tag: &str,
    endpoint: &str,
    expected: &str,
    socket_url: &str,
    challenge: &str,
) -> Result<Authentication> {
    // Validate the complete caller-controlled context before any keystore call.
    let expected_descriptor = descriptor(&decode_fixed::<65>(expected)?)?;
    let message = auth_message(
        endpoint,
        socket_url,
        &expected_descriptor.identity_id,
        challenge,
    )?;
    let key = store.find(tag)?.ok_or("native-key-missing")?;
    let found = descriptor(&store.public_key(&key)?)?;
    if found != expected_descriptor {
        return Err("native-key-mismatch");
    }
    let signature = der_to_raw(&store.sign(&key, &message)?)?;
    Ok(Authentication {
        r#type: "authenticate",
        public_key: found.public_key,
        signature: URL_SAFE_NO_PAD.encode(signature),
    })
}

/// Security.framework returns X9.62 DER; WebCrypto/Workers verify IEEE P1363 r || s.
#[cfg(any(target_os = "macos", test))]
fn der_to_raw(der: &[u8]) -> Result<[u8; 64]> {
    let invalid = "native-signature-invalid";
    if !(8..=72).contains(&der.len()) || der[0] != 0x30 || der[1] as usize != der.len() - 2 {
        return Err(invalid);
    }
    let mut cursor = 2;
    let mut raw = [0u8; 64];
    for target in raw.chunks_mut(32) {
        if der.get(cursor) != Some(&2) {
            return Err(invalid);
        }
        let len = *der.get(cursor + 1).ok_or(invalid)? as usize;
        cursor += 2;
        let encoded = der.get(cursor..cursor + len).ok_or(invalid)?;
        cursor += len;
        if encoded.is_empty() || encoded[0] & 0x80 != 0 {
            return Err(invalid);
        }
        let value = if encoded[0] == 0 {
            if encoded.len() < 2 || encoded[1] & 0x80 == 0 {
                return Err(invalid);
            }
            &encoded[1..]
        } else {
            encoded
        };
        if value.len() > 32 || value.iter().all(|byte| *byte == 0) {
            return Err(invalid);
        }
        target[32 - value.len()..].copy_from_slice(value);
    }
    if cursor != der.len() {
        return Err(invalid);
    }
    Ok(raw)
}

#[tauri::command]
pub fn peer_call_identity_supported(window: WebviewWindow) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        require_caller(window.label(), &window.url().map_err(|_| INVALID)?)?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Capability-only result exposes no signing/key operation. Other platforms retain WebCrypto.
        let _ = window;
        Ok(false)
    }
}

#[tauri::command]
pub async fn peer_call_identity_prepare(
    app: AppHandle,
    window: WebviewWindow,
    endpoint: String,
    expected_public_key: Option<String>,
    allow_create: bool,
) -> Result<Descriptor> {
    require_caller(window.label(), &window.url().map_err(|_| INVALID)?)?;
    let tag = scope(&app.config().identifier, &endpoint)?;
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        macos::noninteractive(|store| {
            prepare(store, &tag, expected_public_key.as_deref(), allow_create)
        })
    })
    .await
    .map_err(|_| "native-unavailable")?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tag, expected_public_key, allow_create);
        Err("native-unavailable")
    }
}

#[tauri::command]
pub async fn peer_call_identity_authenticate(
    app: AppHandle,
    window: WebviewWindow,
    endpoint: String,
    expected_public_key: String,
    socket_url: String,
    challenge: String,
) -> Result<Authentication> {
    require_caller(window.label(), &window.url().map_err(|_| INVALID)?)?;
    let tag = scope(&app.config().identifier, &endpoint)?;
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        macos::noninteractive(|store| {
            authenticate(
                store,
                &tag,
                &endpoint,
                &expected_public_key,
                &socket_url,
                &challenge,
            )
        })
    })
    .await
    .map_err(|_| "native-unavailable")?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tag, expected_public_key, socket_url, challenge);
        Err("native-unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        key: Option<Vec<u8>>,
        fail: Option<&'static str>,
        creates: usize,
    }
    impl KeyStore for Fake {
        type Key = Vec<u8>;
        fn find(&mut self, _: &str) -> Result<Option<Self::Key>> {
            self.fail.map_or_else(|| Ok(self.key.clone()), Err)
        }
        fn create(&mut self, _: &str) -> Result<()> {
            self.creates += 1;
            let mut raw = vec![7; 65];
            raw[0] = 4;
            self.key = Some(raw);
            Ok(())
        }
        fn public_key(&self, key: &Self::Key) -> Result<Vec<u8>> {
            Ok(key.clone())
        }
        fn sign(&self, _: &Self::Key, _: &[u8]) -> Result<Vec<u8>> {
            Ok(vec![0x30, 6, 2, 1, 1, 2, 1, 2])
        }
    }
    const ENDPOINT: &str = "wss://calls.example.test/v2/rooms";
    #[test]
    fn restores_and_never_replaces_missing_pinned_or_unreadable_keys() {
        let mut store = Fake::default();
        let first = prepare(&mut store, "scope", None, true).unwrap();
        assert_eq!(
            prepare(&mut store, "scope", Some(&first.public_key), false).unwrap(),
            first
        );
        assert_eq!(store.creates, 1);
        store.key = None;
        assert_eq!(
            prepare(&mut store, "scope", Some(&first.public_key), false),
            Err("native-key-missing")
        );
        assert_eq!(
            prepare(&mut store, "scope", None, false),
            Err("native-key-missing")
        );
        store.fail = Some("native-interaction-required");
        assert_eq!(
            prepare(&mut store, "scope", None, true),
            Err("native-interaction-required")
        );
        assert_eq!(store.creates, 1);
    }
    #[test]
    fn validates_caller_endpoint_scope_and_fixed_payload() {
        assert!(require_caller("main", &tauri::Url::parse("tauri://localhost/").unwrap()).is_ok());
        for (label, url) in [
            ("call-controls", "tauri://localhost/"),
            ("main", "https://localhost/"),
            ("main", "tauri://other/"),
        ] {
            assert!(require_caller(label, &tauri::Url::parse(url).unwrap()).is_err());
        }
        assert_ne!(
            scope("app.one", ENDPOINT).unwrap(),
            scope("app.two", ENDPOINT).unwrap()
        );
        assert_ne!(
            scope("app.one", ENDPOINT).unwrap(),
            scope("app.one", "wss://other.test/v2/rooms").unwrap()
        );
        for endpoint in [
            "ws://example.test/v2/rooms",
            "wss://user@example.test/v2/rooms",
            "wss://example.test/v2/rooms?x",
            "wss://example.test:443/v2/rooms",
            "wss://example.test/v2/%72ooms",
        ] {
            assert!(canonical_endpoint(endpoint).is_err());
        }
        let id = URL_SAFE_NO_PAD.encode([9; 32]);
        let challenge = URL_SAFE_NO_PAD.encode([8; 32]);
        let socket = format!("wss://calls.example.test/v2/users/{id}");
        assert_eq!(
            auth_message(ENDPOINT, &socket, &id, &challenge).unwrap(),
            format!("yorishiro-call-v2\n/v2/users/{id}\n{challenge}").as_bytes()
        );
        for bad in [
            "wss://other.test/v2/users/x",
            "wss://calls.example.test/v2/users/other",
            "wss://calls.example.test/v2/rooms/not-uuid",
        ] {
            assert!(auth_message(ENDPOINT, bad, &id, &challenge).is_err());
        }
        assert!(auth_message(ENDPOINT, &socket, &id, &"a".repeat(43)).is_err());
    }
    #[test]
    fn authenticates_only_with_pinned_key_and_does_not_create_on_sign() {
        let mut store = Fake::default();
        let first = prepare(&mut store, "scope", None, true).unwrap();
        let socket = format!("wss://calls.example.test/v2/users/{}", first.identity_id);
        let challenge = URL_SAFE_NO_PAD.encode([8; 32]);
        let reply = authenticate(
            &mut store,
            "scope",
            ENDPOINT,
            &first.public_key,
            &socket,
            &challenge,
        )
        .unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(reply.signature).unwrap().len(), 64);
        store.key = None;
        assert!(authenticate(
            &mut store,
            "scope",
            ENDPOINT,
            &first.public_key,
            &socket,
            &challenge
        )
        .is_err());
        assert_eq!(store.creates, 1);
    }
    #[test]
    fn corrupt_or_changed_keys_never_trigger_replacement() {
        let mut store = Fake::default();
        let first = prepare(&mut store, "scope", None, true).unwrap();
        store.key.as_mut().unwrap()[1] = 9;
        assert_eq!(
            prepare(&mut store, "scope", Some(&first.public_key), false),
            Err("native-key-mismatch")
        );
        store.key = Some(vec![1; 65]);
        assert_eq!(
            prepare(&mut store, "scope", None, true),
            Err("native-key-invalid")
        );
        assert_eq!(store.creates, 1);
    }
    #[test]
    fn rejects_malformed_der_and_converts_canonical_sign_padding() {
        let raw = der_to_raw(&[0x30, 6, 2, 1, 1, 2, 1, 2]).unwrap();
        assert_eq!((raw[31], raw[63]), (1, 2));
        for der in [
            &[0x30, 6, 2, 1, 0, 2, 1, 2][..],
            &[0x30, 6, 2, 1, 0x80, 2, 1, 2],
            &[0x30, 7, 2, 2, 0, 1, 2, 1, 2],
            &[0x30, 6, 2, 1, 1, 2, 1, 2, 0],
        ] {
            assert!(der_to_raw(der).is_err());
        }
        let mut valid = vec![0x30, 69, 2, 33, 0];
        valid.extend([0x80; 32]);
        valid.extend([2, 32]);
        valid.extend([1; 32]);
        assert!(der_to_raw(&valid).is_ok());
    }
}
