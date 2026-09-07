/** Keep recovery independent of React and application modules: either may fail to load. */
export function showStartupError(error: unknown): void {
  if (document.getElementById("startup-error")) return;
  const japanese = navigator.language.startsWith("ja");
  const panel = document.createElement("main");
  panel.id = "startup-error";
  panel.setAttribute("role", "alert");
  const title = document.createElement("h1");
  title.textContent = japanese
    ? "Yorishiro を表示できませんでした"
    : "Yorishiro could not be displayed";
  const explanation = document.createElement("p");
  explanation.textContent = japanese
    ? "画面の読み込み中にエラーが発生しました。開発中の場合はコードを修正してから再読み込みしてください。"
    : "An error interrupted the application. If you are developing, fix the code before reloading.";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = japanese ? "再読み込み" : "Reload";
  reload.addEventListener("click", () => window.location.reload());
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = japanese ? "エラーの詳細" : "Error details";
  const message = document.createElement("pre");
  message.textContent = error instanceof Error ? error.stack || error.message : String(error);
  details.append(summary, message);
  panel.append(title, explanation, reload, details);
  document.body.append(panel);
  reload.focus();
}

export async function startApplication(load: () => Promise<unknown>): Promise<void> {
  try {
    await load();
  } catch (error) {
    showStartupError(error);
  }
}
