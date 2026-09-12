export const MIN_SHARING_INTERVAL_SECONDS = 10;
export const MAX_SHARING_INTERVAL_SECONDS = 300;

export function formatSharingInterval(value: number, language: string): string {
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (language === "ja") {
    return `${minutes ? `${minutes}分` : ""}${seconds ? `${seconds}秒` : ""}ごと`;
  }
  return `Every ${minutes ? `${minutes}m` : ""}${minutes && seconds ? " " : ""}${seconds ? `${seconds}s` : ""}`;
}
