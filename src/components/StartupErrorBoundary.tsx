import { Component, type ReactNode } from "react";
import { showStartupError } from "../startup-error";

/** Sits outside lazy imports, including the application's richer recovery screen. */
export class StartupErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    showStartupError(error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
