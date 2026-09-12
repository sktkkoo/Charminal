import { type ReactNode, useId } from "react";
import type { ScreenCaptureRegion, ScreenSourceKind } from "./bindings/tauri-commands";

export interface ScreenSourceOptionsProps {
  readonly children?: ReactNode;
  readonly screenSelectionSupported?: boolean;
  readonly kind: ScreenSourceKind;
  readonly region?: ScreenCaptureRegion | null;
  readonly disabled?: boolean;
  readonly language: string;
  readonly onKindChange: (kind: ScreenSourceKind) => void;
}

/** Shared controls for the main window and its auxiliary sharing settings. */
export function ScreenSourceOptions({
  kind,
  screenSelectionSupported = true,
  children,
  disabled,
  language,
  onKindChange,
}: ScreenSourceOptionsProps) {
  const id = useId();
  const kinds = ["display", "window", "region"] as const;
  const ja = language.startsWith("ja");
  return (
    <div className="screen-source-options">
      <div
        role="tablist"
        className="screen-source-kinds"
        aria-label={ja ? "画面の共有方法" : "Screen source type"}
      >
        {kinds.map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${id}-${value}`}
            aria-selected={kind === value}
            aria-controls={`${id}-panel`}
            tabIndex={kind === value ? 0 : -1}
            disabled={disabled || (value !== "display" && !screenSelectionSupported)}
            title={
              value !== "display" && !screenSelectionSupported
                ? ja
                  ? "実行中のアプリではまだ利用できません"
                  : "Not available in the running app yet"
                : undefined
            }
            onClick={() => onKindChange(value)}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === "ArrowRight"
                  ? (index + 1) % kinds.length
                  : event.key === "ArrowLeft"
                    ? (index + kinds.length - 1) % kinds.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? kinds.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const next = kinds[nextIndex];
              const nextTab = document.getElementById(`${id}-${next}`);
              if (nextTab instanceof HTMLButtonElement && !nextTab.disabled) {
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  .forEach((tab) => {
                    tab.tabIndex = tab === nextTab ? 0 : -1;
                  });
                nextTab.focus();
              }
            }}
          >
            {value === "display"
              ? ja
                ? "画面全体"
                : "Display"
              : value === "window"
                ? ja
                  ? "ウィンドウ"
                  : "Window"
                : ja
                  ? "範囲選択"
                  : "Area"}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${kind}`}>
        {children}
      </div>
    </div>
  );
}
