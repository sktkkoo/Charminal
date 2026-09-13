//! File-based macOS Keychain: creator-only ACL + explicit non-exportability.
//! A stable code-signing requirement is required across app updates. Never broaden the ACL to
//! accommodate ad-hoc rebuilds. Data-protection Keychain needs provisioning entitlements and is
//! deliberately not used as an implicit fallback for local test bundles.
use super::{KeyStore, Result};
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    data::CFData,
    dictionary::CFDictionary,
    error::{kCFErrorDomainOSStatus, CFError},
    number::CFNumber,
    string::{CFString, CFStringRef},
};
use security_framework::{
    key::{Algorithm, SecKey},
    os::macos::access::SecAccess,
};
use security_framework_sys::{
    base::{SecAccessRef, SecKeychainAttributeList, SecKeychainItemRef},
    item::*,
    keychain::{SecKeychainGetUserInteractionAllowed, SecKeychainSetUserInteractionAllowed},
    keychain_item::SecItemCopyMatching,
};
use std::{ffi::c_void, ptr, sync::Mutex};

// SecBase.h: the public legacy API takes one array of attribute tags and formats.
#[repr(C)]
struct AttributeInfo {
    count: u32,
    tag: *mut u32,
    format: *mut u32,
}
const KEY_EXTRACTABLE: u32 = 16; // SecKey.h: kSecKeyExtractable
const ATTRIBUTE_UINT32: u32 = 2; // cssmtype.h: CSSM_DB_ATTRIBUTE_FORMAT_UINT32

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecAttrApplicationTag: CFStringRef;
    static kSecAttrIsExtractable: CFStringRef;
    static kSecAttrAccess: CFStringRef;
    static kSecUseAuthenticationUIFail: CFStringRef;
    fn SecAccessCreate(
        descriptor: CFStringRef,
        trusted: CFArrayRef,
        access: *mut SecAccessRef,
    ) -> i32;
    fn SecKeychainItemCopyAttributesAndData(
        item: SecKeychainItemRef,
        info: *mut AttributeInfo,
        item_class: *mut u32,
        attributes: *mut *mut SecKeychainAttributeList,
        data_length: *mut u32,
        data: *mut *mut c_void,
    ) -> i32;
    fn SecKeychainItemFreeAttributesAndData(
        attributes: *mut SecKeychainAttributeList,
        data: *mut c_void,
    ) -> i32;
}

static OPERATIONS: Mutex<()> = Mutex::new(());

/// The process setting also covers generation/signing, unlike the lookup-only UI-fail flag.
/// It is held only around a synchronous Security.framework operation, never across an await.
struct NoInteraction(u8);
impl NoInteraction {
    fn enter() -> Result<Self> {
        let mut previous = 0;
        unsafe {
            if SecKeychainGetUserInteractionAllowed(&mut previous) != 0
                || SecKeychainSetUserInteractionAllowed(0) != 0
            {
                return Err("native-interaction-required");
            }
        }
        Ok(Self(previous))
    }
}
impl Drop for NoInteraction {
    fn drop(&mut self) {
        // Restoring a process UI setting cannot itself access a key or display a dialog.
        unsafe {
            SecKeychainSetUserInteractionAllowed(self.0);
        }
    }
}

pub(super) fn noninteractive<T>(operation: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let _lock = OPERATIONS.lock().map_err(|_| "native-unavailable")?;
    let _guard = NoInteraction::enter()?;
    operation(&mut Store)
}

fn status_error(status: i32) -> &'static str {
    match status {
        -25308 | -25293 | -128 => "native-interaction-required",
        _ => "native-unavailable",
    }
}

fn creation_error(is_os_status: bool, code: isize) -> &'static str {
    if !is_os_status {
        return "native-key-create-unavailable";
    }
    match code {
        -50 => "native-key-create-invalid-parameters",
        -25308 | -25293 | -128 => "native-key-create-interaction-required",
        -25299 => "native-key-create-duplicate",
        -4 => "native-key-create-unsupported",
        _ => "native-key-create-unavailable",
    }
}

fn classify_creation_error(error: CFError) -> &'static str {
    // Never inspect descriptions/userInfo: these can contain provider/key data. Only classify a
    // known domain and a fixed set of public OSStatus constants; all other values are collapsed.
    creation_error(
        error.domain() == unsafe { string(kCFErrorDomainOSStatus) },
        error.code(),
    )
}

fn string(value: CFStringRef) -> CFString {
    // All callers pass static public Security.framework constants.
    unsafe { CFString::wrap_under_get_rule(value) }
}
fn attribute(dictionary: &CFDictionary, key: CFStringRef) -> Option<CFType> {
    dictionary
        .find(key.cast())
        .map(|value| unsafe { CFType::wrap_under_get_rule(*value) })
}

fn is_ec_key_type(value: &CFType) -> bool {
    // SecItem.h documents CFNumber/CSSM_ALGORITHMS; the modern API also returns the
    // CFString EC constant. Both exact encodings denote CSSM_ALGID_ECDSA (cssmtype.h:900).
    value
        .downcast::<CFString>()
        .is_some_and(|kind| unsafe { kind == string(kSecAttrKeyTypeECSECPrimeRandom) })
        || value.downcast::<CFNumber>().and_then(|kind| kind.to_i32()) == Some(73)
}

/// Unlike SecKeyCopyAttributes, this public API does not request a key's data/export representation.
/// Apple SecBridge.h explicitly accepts a legacy SecKeyRef as the item reference; Item.cpp calls
/// getContent(attributes, NULL) when outData is NULL. Modern/nonlegacy keys fail closed here.
fn verify_legacy_nonextractable(key: &SecKey) -> Result<()> {
    let mut tag = KEY_EXTRACTABLE;
    let mut format = ATTRIBUTE_UINT32;
    let mut info = AttributeInfo {
        count: 1,
        tag: &mut tag,
        format: &mut format,
    };
    let mut attributes = ptr::null_mut();
    let status = unsafe {
        SecKeychainItemCopyAttributesAndData(
            key.as_concrete_TypeRef().cast(),
            &mut info,
            ptr::null_mut(),
            &mut attributes,
            ptr::null_mut(),
            ptr::null_mut(), // Never ask for key data, even as a verification probe.
        )
    };
    struct OwnedAttributes(*mut SecKeychainAttributeList);
    impl Drop for OwnedAttributes {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    SecKeychainItemFreeAttributesAndData(self.0, ptr::null_mut());
                }
            }
        }
    }
    let owned = OwnedAttributes(attributes);
    if status != 0 {
        return Err(if matches!(status, -25308 | -25293 | -128) {
            "native-interaction-required"
        } else {
            "native-key-protection-attribute-missing"
        });
    }
    // SAFETY: Security.framework owns the returned allocation. All lengths/tags are checked
    // before reading the single four-byte public policy flag. It is freed on every return path.
    unsafe { verify_protection_attribute(owned.0) }
}

unsafe fn verify_protection_attribute(attributes: *const SecKeychainAttributeList) -> Result<()> {
    let invalid = "native-key-protection-attribute-missing";
    if attributes.is_null() {
        return Err(invalid);
    }
    let list = unsafe { &*attributes };
    if list.count != 1 || list.attr.is_null() {
        return Err(invalid);
    }
    let attribute = unsafe { &*list.attr };
    if attribute.tag != KEY_EXTRACTABLE || attribute.length != 4 || attribute.data.is_null() {
        return Err(invalid);
    }
    match unsafe { attribute.data.cast::<u32>().read_unaligned() } {
        0 => Ok(()),
        1 => Err("native-key-exportable"),
        _ => Err(invalid),
    }
}

fn generation_attributes(tag: &str, label: &CFString, creator_access: &CFType) -> CFDictionary {
    let private = unsafe {
        CFDictionary::from_CFType_pairs(&[
            (
                string(kSecAttrIsPermanent),
                CFBoolean::true_value().as_CFType(),
            ),
            (
                string(kSecAttrApplicationTag),
                CFData::from_buffer(tag.as_bytes()).as_CFType(),
            ),
            (
                string(kSecAttrIsExtractable),
                CFBoolean::false_value().as_CFType(),
            ),
            (string(kSecAttrAccess), creator_access.clone()),
            (string(kSecAttrLabel), label.as_CFType()),
        ])
    };
    let public = unsafe {
        CFDictionary::from_CFType_pairs(&[
            // Legacy SecKeyCopyPublicKey retrieves the persisted public companion after restart;
            // its in-memory mPublicKey reference exists only in the key-creation process.
            (
                string(kSecAttrIsPermanent),
                CFBoolean::true_value().as_CFType(),
            ),
            (
                string(kSecAttrIsExtractable),
                CFBoolean::true_value().as_CFType(),
            ),
            (
                string(kSecAttrApplicationTag),
                CFData::from_buffer(tag.as_bytes()).as_CFType(),
            ),
            (string(kSecAttrLabel), label.as_CFType()),
        ])
    };
    unsafe {
        CFDictionary::from_CFType_pairs(&[
            (
                string(kSecAttrKeyType),
                string(kSecAttrKeyTypeECSECPrimeRandom).as_CFType(),
            ),
            (
                string(kSecAttrKeySizeInBits),
                CFNumber::from(256).as_CFType(),
            ),
            // macOS legacy SecKey.cpp GetKeyParameters and MakeKeyGenParametersFromDictionary
            // inspect these two attributes only at top level. Nested-only values are ignored.
            // Keep identical policy at both levels for the documented modern/legacy forms.
            (
                string(kSecAttrIsExtractable),
                CFBoolean::false_value().as_CFType(),
            ),
            (string(kSecAttrAccess), creator_access.clone()),
            (string(kSecPrivateKeyAttrs), private.as_CFType()),
            (string(kSecPublicKeyAttrs), public.as_CFType()),
        ])
        .into_untyped()
    }
}

pub(super) struct Store;
impl KeyStore for Store {
    type Key = SecKey;
    fn find(&mut self, tag: &str) -> Result<Option<SecKey>> {
        let query = unsafe {
            CFDictionary::from_CFType_pairs(&[
                (string(kSecClass), string(kSecClassKey).as_CFType()),
                (
                    string(kSecAttrApplicationTag),
                    CFData::from_buffer(tag.as_bytes()).as_CFType(),
                ),
                (
                    string(kSecAttrKeyClass),
                    string(kSecAttrKeyClassPrivate).as_CFType(),
                ),
                // All lets us reject duplicate records; a hidden/denied record must not mean absence.
                (
                    string(kSecMatchLimit),
                    string(kSecMatchLimitAll).as_CFType(),
                ),
                (string(kSecReturnRef), CFBoolean::true_value().as_CFType()),
                (
                    string(kSecReturnAttributes),
                    CFBoolean::true_value().as_CFType(),
                ),
                (
                    string(kSecUseAuthenticationUI),
                    string(kSecUseAuthenticationUIFail).as_CFType(),
                ),
            ])
        };
        let mut result: CFTypeRef = ptr::null();
        let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
        // No auth-UI Skip, fallback search, delete, or create after any other failure.
        if status == -25300 {
            return Ok(None);
        }
        if status != 0 {
            return Err(status_error(status));
        }
        if result.is_null() {
            return Err("native-key-invalid");
        }
        let result = unsafe { CFType::wrap_under_create_rule(result) };
        let array = result.downcast::<CFArray>().ok_or("native-key-invalid")?;
        if array.len() != 1 {
            return Err("native-key-invalid");
        }
        let item =
            unsafe { CFType::wrap_under_get_rule(*array.get(0).ok_or("native-key-invalid")?) };
        let attrs = item
            .downcast::<CFDictionary>()
            .ok_or("native-key-invalid")?;
        unsafe {
            let key = attribute(&attrs, kSecValueRef).ok_or("native-key-invalid")?;
            if key.type_of() != SecKey::type_id() {
                return Err("native-key-invalid");
            }
            let key = SecKey::wrap_under_get_rule(key.as_CFTypeRef().cast_mut().cast());
            match attribute(&attrs, kSecAttrIsExtractable) {
                Some(value) if value.downcast::<CFBoolean>() == Some(CFBoolean::false_value()) => {}
                Some(value) if value.downcast::<CFBoolean>() == Some(CFBoolean::true_value()) => {
                    return Err("native-key-exportable")
                }
                Some(_) => return Err("native-key-protection-attribute-missing"),
                // Legacy SecItem.cpp does not expose the Extractable database column. Read only
                // that policy attribute from the exact returned key; never infer it from creation.
                None => verify_legacy_nonextractable(&key)?,
            }
            let kind =
                attribute(&attrs, kSecAttrKeyType).is_some_and(|value| is_ec_key_type(&value));
            let size = attribute(&attrs, kSecAttrKeySizeInBits)
                .and_then(|value| value.downcast::<CFNumber>())
                .and_then(|value| value.to_i32());
            if !kind || size != Some(256) {
                return Err("native-key-algorithm-invalid");
            }
            Ok(Some(key))
        }
    }
    fn create(&mut self, tag: &str) -> Result<()> {
        let label = CFString::new("Yorishiro managed call identity");
        let mut access: SecAccessRef = ptr::null_mut();
        // NULL means only the creating application is trusted, not an empty/any-app ACL.
        let status =
            unsafe { SecAccessCreate(label.as_concrete_TypeRef(), ptr::null(), &mut access) };
        if status != 0 {
            return Err(status_error(status));
        }
        if access.is_null() {
            return Err("native-key-access-invalid");
        }
        let access = unsafe { SecAccess::wrap_under_create_rule(access) };
        let attributes = generation_attributes(tag, &label, &access.as_CFType());
        // Custom attributes are necessary: GenerateKeyOptions cannot express extractability/ACL.
        #[allow(deprecated)]
        SecKey::generate(attributes).map_err(classify_creation_error)?;
        Ok(())
    }
    fn public_key(&self, key: &SecKey) -> Result<Vec<u8>> {
        let public = key.public_key().ok_or("native-key-invalid")?;
        // This is deliberately the only export call. Its receiver is a public-only SecKey.
        public
            .external_representation()
            .map(|data| data.to_vec())
            .ok_or("native-key-invalid")
    }
    fn sign(&self, key: &SecKey, message: &[u8]) -> Result<Vec<u8>> {
        key.create_signature(Algorithm::ECDSASignatureMessageX962SHA256, message)
            .map_err(|_| "native-signing-unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_documented_ec_attribute_encodings() {
        assert!(is_ec_key_type(
            &unsafe { string(kSecAttrKeyTypeECSECPrimeRandom) }.as_CFType()
        ));
        assert!(is_ec_key_type(&CFNumber::from(73).as_CFType()));
        assert!(!is_ec_key_type(&CFNumber::from(42).as_CFType()));
        assert!(!is_ec_key_type(&CFBoolean::true_value().as_CFType()));
        assert!(!is_ec_key_type(&CFString::new("EC").as_CFType()));
    }
    #[test]
    fn creation_diagnostics_are_static_and_allowlisted() {
        assert_eq!(
            creation_error(true, -50),
            "native-key-create-invalid-parameters"
        );
        assert_eq!(
            creation_error(true, -25308),
            "native-key-create-interaction-required"
        );
        assert_eq!(creation_error(true, -25299), "native-key-create-duplicate");
        assert_eq!(creation_error(true, -4), "native-key-create-unsupported");
        assert_eq!(
            creation_error(true, 123456),
            "native-key-create-unavailable"
        );
        assert_eq!(creation_error(false, -50), "native-key-create-unavailable");
    }
    #[test]
    fn legacy_generation_has_top_level_nonexportable_and_same_creator_acl() {
        // A public opaque sentinel tests dictionary construction without creating/accessing any ACL.
        // Production passes only the SecAccess created with a NULL trusted-application list above.
        let access = CFString::new("creator-acl-test-sentinel").as_CFType();
        let attrs =
            generation_attributes("app.endpoint.scope", &CFString::new("test label"), &access);
        unsafe {
            assert_eq!(
                attribute(&attrs, kSecAttrIsExtractable).and_then(|v| v.downcast::<CFBoolean>()),
                Some(CFBoolean::false_value())
            );
            assert_eq!(
                attribute(&attrs, kSecAttrAccess).unwrap().as_CFTypeRef(),
                access.as_CFTypeRef()
            );
            let private = attribute(&attrs, kSecPrivateKeyAttrs)
                .unwrap()
                .downcast::<CFDictionary>()
                .unwrap();
            assert_eq!(
                attribute(&private, kSecAttrIsExtractable).and_then(|v| v.downcast::<CFBoolean>()),
                Some(CFBoolean::false_value())
            );
            assert_eq!(
                attribute(&private, kSecAttrAccess).unwrap().as_CFTypeRef(),
                access.as_CFTypeRef()
            );
            assert_eq!(
                attribute(&private, kSecAttrApplicationTag)
                    .unwrap()
                    .downcast::<CFData>()
                    .unwrap()
                    .to_vec(),
                b"app.endpoint.scope"
            );
            assert_eq!(
                attribute(&private, kSecAttrIsPermanent).and_then(|v| v.downcast::<CFBoolean>()),
                Some(CFBoolean::true_value())
            );
            let public = attribute(&attrs, kSecPublicKeyAttrs)
                .unwrap()
                .downcast::<CFDictionary>()
                .unwrap();
            assert_eq!(
                attribute(&public, kSecAttrIsPermanent).and_then(|v| v.downcast::<CFBoolean>()),
                Some(CFBoolean::true_value())
            );
            assert_eq!(
                attribute(&public, kSecAttrIsExtractable).and_then(|v| v.downcast::<CFBoolean>()),
                Some(CFBoolean::true_value())
            );
        }
    }
    #[test]
    fn metadata_only_protection_check_rejects_exportable_missing_and_malformed_flags() {
        use security_framework_sys::base::SecKeychainAttribute;
        fn check(mut flag: u32, tag: u32, length: u32, count: u32) -> Result<()> {
            let mut attr = SecKeychainAttribute {
                tag,
                length,
                data: (&mut flag as *mut u32).cast(),
            };
            let list = SecKeychainAttributeList {
                count,
                attr: &mut attr,
            };
            unsafe { verify_protection_attribute(&list) }
        }
        assert_eq!(check(0, KEY_EXTRACTABLE, 4, 1), Ok(()));
        assert_eq!(
            check(1, KEY_EXTRACTABLE, 4, 1),
            Err("native-key-exportable")
        );
        assert!(check(2, KEY_EXTRACTABLE, 4, 1).is_err());
        assert!(check(0, KEY_EXTRACTABLE, 0, 1).is_err());
        assert!(check(0, 999, 4, 1).is_err());
        assert!(check(0, KEY_EXTRACTABLE, 4, 2).is_err());
        assert!(unsafe { verify_protection_attribute(ptr::null()) }.is_err());
    }
}
