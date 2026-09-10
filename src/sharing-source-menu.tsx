import { Camera, MonitorUp } from "lucide-react";

/** Choosing a source opens its settings; capture still requires an explicit Start. */
export function SharingSourceMenu({
  language,
  disabled,
  onSelect,
}: {
  language?: string;
  disabled?: boolean;
  onSelect: (kind: "screen" | "camera") => void;
}) {
  const japanese = language?.startsWith("ja");
  return (
    <fieldset
      className="sharing-source-menu"
      aria-label={japanese ? "共有するもの" : "What to share"}
    >
      <button type="button" disabled={disabled} onClick={() => onSelect("screen")}>
        <MonitorUp size={18} aria-hidden="true" />
        {japanese ? "画面を共有" : "Share screen"}
      </button>
      <button type="button" disabled={disabled} onClick={() => onSelect("camera")}>
        <Camera size={18} aria-hidden="true" />
        {japanese ? "カメラを共有" : "Share camera"}
      </button>
    </fieldset>
  );
}
