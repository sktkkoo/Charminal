interface Props {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly language: string;
  readonly onRetry?: () => void;
  readonly onChange: (enabled: boolean) => void;
}

export function ScreenPointerToggle({ enabled, ready, language, onChange, onRetry }: Props) {
  const japanese = language.startsWith("ja");
  const label = japanese ? "エージェントの指し示し" : "Agent pointing";
  return (
    <div>
      <label className="screen-sharing-pointer-toggle">
        <span className="screen-sharing-label">{label}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          aria-checked={enabled}
          checked={enabled}
          disabled={!ready}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </label>
      {!ready && onRetry ? (
        <button type="button" className="screen-sharing-action" onClick={onRetry}>
          {japanese ? "指し示し設定を再試行" : "Retry pointing setup"}
        </button>
      ) : null}
    </div>
  );
}
