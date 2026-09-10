import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { MediaPermissionKind } from "./runtime/media-permissions";
import "./media-permission-help.css";

export function MediaPermissionHelp({
  kind,
  language = navigator.language,
}: {
  kind: MediaPermissionKind;
  language?: string;
}) {
  const japanese = language.startsWith("ja");
  const mac = /Mac/i.test(navigator.platform);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = japanese
    ? { camera: "カメラ", microphone: "マイク", screen: "画面収録" }[kind]
    : { camera: "Camera", microphone: "Microphone", screen: "Screen Recording" }[kind];
  return (
    <div className="media-permission-help" role="alert">
      <p>
        {japanese
          ? `${name}の許可が必要です。${mac ? `システム設定の「プライバシーとセキュリティ → ${name}」でYorishiroを許可してから、もう一度開始してください。` : "端末またはブラウザの設定で許可してから、もう一度開始してください。"}`
          : `${name} permission is required. ${mac ? `Allow Yorishiro in System Settings → Privacy & Security → ${name}, then start again.` : "Allow access in your device or browser settings, then start again."}`}
      </p>
      {mac ? (
        <button
          type="button"
          disabled={opening}
          onClick={() => {
            setOpening(true);
            setFailed(false);
            void invoke("open_media_permission_settings", { kind })
              .catch(() => setFailed(true))
              .finally(() => setOpening(false));
          }}
        >
          {japanese ? "システム設定を開く" : "Open System Settings"}
        </button>
      ) : null}
      {failed ? (
        <p>
          {japanese
            ? "設定を開けませんでした。システム設定から手動で開いてください。"
            : "Could not open settings. Open System Settings manually."}
        </p>
      ) : null}
    </div>
  );
}
