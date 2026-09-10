import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import { StartupErrorBoundary } from "./components/StartupErrorBoundary";
import { resolveWindowView } from "./runtime/auxiliary-windows";

const view = resolveWindowView(
  isTauri() ? getCurrentWindow().label : "main",
  window.location.search,
);
document.documentElement.dataset.windowView = view ?? "unknown";
const Application = React.lazy(async () => {
  if (view === "screen-preview") return import("./auxiliary-screen-preview");
  if (view === "camera-preview") return import("./auxiliary-camera-preview");
  if (view === "screen-sharing-controls") return import("./auxiliary-screen-sharing");
  if (view !== "main") return { default: () => <p>Unknown auxiliary window.</p> };
  // Do not load main-window modules in an auxiliary WebView: they own sessions and captures.
  const [{ default: App }, { AppErrorBoundary }] = await Promise.all([
    import("./App"),
    import("./components/AppErrorBoundary"),
  ]);
  return {
    default: () => (
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    ),
  };
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StartupErrorBoundary>
      <React.Suspense fallback={null}>
        <Application />
      </React.Suspense>
    </StartupErrorBoundary>
  </React.StrictMode>,
);
