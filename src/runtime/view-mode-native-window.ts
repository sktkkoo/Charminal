import { LogicalSize, type Window } from "@tauri-apps/api/window";
import type { UiLayout } from "@yorishiro/sdk";

export interface WindowAspectRatioStrategy {
  readonly nativeAspectRatio: number | null;
  readonly jsAspectRatio: number | null;
}

export function resolveWindowAspectRatioStrategy(
  _aspectRatio: number | undefined,
  _macos: boolean,
): WindowAspectRatioStrategy {
  return { nativeAspectRatio: null, jsAspectRatio: null };
}

let nativeWindowMutationQueue = Promise.resolve();

export function enqueueNativeWindowMutation(operation: () => Promise<void>): Promise<void> {
  const result = nativeWindowMutationQueue.then(operation);
  nativeWindowMutationQueue = result.catch(() => undefined);
  return result;
}

type LayoutWindow = Pick<
  Window,
  | "innerSize"
  | "scaleFactor"
  | "isFullscreen"
  | "setFullscreen"
  | "isMaximized"
  | "maximize"
  | "unmaximize"
  | "setMinSize"
  | "setSize"
  | "setAlwaysOnTop"
>;

/** Call through the native mutation queue so a later mode cannot overtake an earlier one. */
export function createNativeWindowLayoutApplier(
  appWindow: LayoutWindow,
  exitFullscreen: () => Promise<void>,
) {
  let savedSize: LogicalSize | null = null;
  let savedMaximized: boolean | null = null;
  let savedFullscreen: boolean | null = null;

  const readSize = async () => {
    const [size, scale] = await Promise.all([appWindow.innerSize(), appWindow.scaleFactor()]);
    return size.toLogical(scale);
  };

  return async (layout: UiLayout | null): Promise<void> => {
    const windowLayout = layout?.window;
    // Fullscreen owns the display dimensions; compact sizes apply only in windowed modes.
    const requestsSize =
      windowLayout?.fullscreen !== true &&
      (windowLayout?.width !== undefined || windowLayout?.height !== undefined);
    const fullscreen = await appWindow.isFullscreen();
    if (layout && savedFullscreen === null) savedFullscreen = fullscreen;
    // An explicit compact size takes precedence over inherited fullscreen state.
    const targetFullscreen =
      windowLayout?.fullscreen ?? (requestsSize ? false : (savedFullscreen ?? fullscreen));
    const resizesWindow = requestsSize || savedSize !== null;
    if (resizesWindow || !targetFullscreen) {
      // macOS setFullscreen resolves before its Space transition completes.
      await exitFullscreen();
    }
    if (requestsSize && savedSize === null) {
      savedMaximized = await appWindow.isMaximized();
      if (savedMaximized) await appWindow.unmaximize();
      savedSize = await readSize();
    } else if (resizesWindow && (await appWindow.isMaximized())) {
      await appWindow.unmaximize();
    }

    await appWindow.setMinSize(
      new LogicalSize(windowLayout?.minWidth ?? 900, windowLayout?.minHeight ?? 600),
    );
    if (requestsSize) {
      const currentSize = await readSize();
      await appWindow.setSize(
        new LogicalSize(
          windowLayout?.width ?? currentSize.width,
          windowLayout?.height ?? currentSize.height,
        ),
      );
    } else if (savedSize !== null) {
      await appWindow.setSize(savedSize);
      if (savedMaximized) await appWindow.maximize();
      savedSize = null;
      savedMaximized = null;
    }
    await appWindow.setAlwaysOnTop(windowLayout?.alwaysOnTop ?? false);
    if (targetFullscreen) await appWindow.setFullscreen(true);
    if (!layout) savedFullscreen = null;
  };
}
