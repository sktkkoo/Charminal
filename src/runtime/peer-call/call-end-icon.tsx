/** A horizontal hang-up handset, distinct from a disabled phone. */
export function CallEndIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12a15.5 15.5 0 0 1 20 0v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-3a12 12 0 0 0-8 0v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
    </svg>
  );
}
