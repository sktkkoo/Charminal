interface Props {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly language: string;
  readonly onRetry?: () => void;
  readonly onChange: (enabled: boolean) => void;
}

export function ScreenPointerToggle({ enabled, ready, language, onChange, onRetry }: Props) {
  const japanese = language.startsWith("ja");
  const label = japanese ? "画面の目印" : "Screen markers";
  return (
    <div>
      <label className="screen-sharing-pointer-toggle">
        <span>
          <span className="screen-sharing-label">{label}</span>
          <small>{japanese ? "オフでも画面共有は続きます。" : "Sharing continues when off."}</small>
        </span>
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
          {japanese ? "目印の設定を再試行" : "Retry marker setting"}
        </button>
      ) : null}
    </div>
  );
}
