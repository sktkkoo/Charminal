/** Hide the inline monitor for the native snapshot; retain layout and always restore it. */
let captures = 0;
export async function withoutInlineScreenPreview<T>(
  capture: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (!document.querySelector("[data-screen-preview-inline]")) return capture();
  captures += 1;
  document.documentElement.setAttribute("data-screen-capturing", "");
  try {
    await new Promise<void>((resolve) => {
      let first = 0;
      let second = 0;
      const finish = () => {
        clearTimeout(timer);
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      // Occluded WebViews may suspend animation frames.
      const timer = setTimeout(finish, 100);
      signal.addEventListener("abort", finish, { once: true });
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(finish);
      });
      if (signal.aborted) finish();
    });
    signal.throwIfAborted();
    return await capture();
  } finally {
    captures -= 1;
    if (!captures) document.documentElement.removeAttribute("data-screen-capturing");
  }
}
