/// Complete the native fullscreen transition before compact mode resizes the window.
#[tauri::command]
pub async fn exit_window_fullscreen(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::exit(window).await;

    #[cfg(not(target_os = "macos"))]
    {
        if window.is_fullscreen().map_err(|error| error.to_string())? {
            window
                .set_fullscreen(false)
                .map_err(|error| error.to_string())?;
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while window.is_fullscreen().map_err(|error| error.to_string())? {
                    tokio::time::sleep(std::time::Duration::from_millis(16)).await;
                }
                Ok::<(), String>(())
            })
            .await
            .map_err(|_| "Fullscreen exit timed out".to_string())??;
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::{msg_send, rc::Retained, runtime::ProtocolObject};
    use objc2_app_kit::{NSWindowDidExitFullScreenNotification, NSWindowStyleMask};
    use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
    use std::{
        cell::RefCell,
        collections::HashMap,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };
    use tauri::Manager;
    use tokio::sync::oneshot;

    thread_local! {
        // AppKit observer ownership never leaves the main thread.
        static OBSERVERS: RefCell<HashMap<u64, Retained<ProtocolObject<dyn NSObjectProtocol>>>> = RefCell::new(HashMap::new());
    }
    static NEXT_OBSERVER: AtomicU64 = AtomicU64::new(1);

    struct ObserverCleanup {
        app: tauri::AppHandle,
        id: u64,
    }

    impl Drop for ObserverCleanup {
        fn drop(&mut self) {
            let id = self.id;
            let _ = self.app.run_on_main_thread(move || {
                OBSERVERS.with(|observers| {
                    if let Some(observer) = observers.borrow_mut().remove(&id) {
                        unsafe {
                            NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref());
                        }
                    }
                });
            });
        }
    }

    pub(super) async fn exit(window: tauri::WebviewWindow) -> Result<(), String> {
        let id = NEXT_OBSERVER.fetch_add(1, Ordering::Relaxed);
        let _cleanup = ObserverCleanup {
            app: window.app_handle().clone(),
            id,
        };
        let (sender, receiver) = oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        let native_window = window.clone();
        window
            .run_on_main_thread(move || {
                // Cancellation before this queued callback must not initiate a transition.
                if sender
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_none_or(|sender| sender.is_closed())
                {
                    return;
                }
                let result = (|| -> Result<bool, String> {
                    let pointer = native_window
                        .ns_window()
                        .map_err(|error| error.to_string())?;
                    let object = unsafe { &*pointer.cast::<objc2::runtime::AnyObject>() };
                    let style: usize = unsafe { msg_send![object, styleMask] };
                    if style & NSWindowStyleMask::FullScreen.bits() == 0 {
                        return Ok(false);
                    }
                    let completed = Arc::clone(&sender);
                    let block = RcBlock::new(move |_| {
                        if let Some(sender) = completed.lock().unwrap().take() {
                            let _ = sender.send(Ok(()));
                        }
                    });
                    let observer = unsafe {
                        NSNotificationCenter::defaultCenter()
                            .addObserverForName_object_queue_usingBlock(
                                Some(NSWindowDidExitFullScreenNotification),
                                Some(object),
                                None,
                                &block,
                            )
                    };
                    OBSERVERS.with(|observers| {
                        observers.borrow_mut().insert(id, observer);
                    });
                    // Tao updates its cached flag before AppKit finishes the animation.
                    // Only the notification above authorizes the caller to resize.
                    native_window
                        .set_fullscreen(false)
                        .map_err(|error| error.to_string())?;
                    Ok(true)
                })();
                if !matches!(result, Ok(true)) {
                    if let Some(sender) = sender.lock().unwrap().take() {
                        let _ = sender.send(result.map(|_| ()));
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        tokio::time::timeout(Duration::from_secs(10), receiver)
            .await
            .map_err(|_| "Fullscreen exit timed out".to_string())?
            .map_err(|_| "Fullscreen exit notification was cancelled".to_string())?
    }
}
