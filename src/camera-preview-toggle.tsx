interface Props {
  readonly visible: boolean;
  readonly disabled?: boolean;
  readonly language: string;
  readonly onChange: (visible: boolean) => void;
}

export function CameraPreviewToggle({ visible, disabled, language, onChange }: Props) {
  const label = language.startsWith("ja") ? "プレビュー" : "Preview";
  return (
    <label className="screen-sharing-pointer-toggle">
      <span className="screen-sharing-label">{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-checked={visible}
        checked={visible}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}
