interface ScreenContextNotification {
  /** One accepted connection owner; replacement must not wait for its predecessor's RPC. */
  readonly client: object;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly notify: () => Promise<void>;
}

interface QueuedNotification {
  readonly notification: ScreenContextNotification;
  readonly onAbort: () => void;
}

/**
 * Best-effort availability metadata, separate from image delivery. Keep one RPC
 * in flight and only the newest waiting metadata. Never retain image content.
 */
export class ScreenContextNotifications {
  private active: { readonly client: object } | null = null;
  private queued: QueuedNotification | null = null;

  enqueue(notification: ScreenContextNotification): void {
    if (!this.isCurrent(notification)) return;
    if (this.active && this.active.client !== notification.client) this.reset();
    this.clearQueued();
    if (!this.active) {
      this.dispatch(notification);
      return;
    }
    const queued: QueuedNotification = {
      notification,
      onAbort: () => {
        if (this.queued === queued) this.clearQueued();
      },
    };
    this.queued = queued;
    notification.signal.addEventListener("abort", queued.onAbort, { once: true });
  }

  /** Already-sent metadata cannot be retracted; its completion cannot drain a new owner's queue. */
  reset(): void {
    this.active = null;
    this.clearQueued();
  }

  /** Revoke waiting metadata without allowing overlapping RPCs on the same voice client. */
  cancelPending(): void {
    this.clearQueued();
  }

  private isCurrent(notification: ScreenContextNotification): boolean {
    return !notification.signal.aborted && notification.isCurrent();
  }

  private clearQueued(): void {
    const queued = this.queued;
    this.queued = null;
    queued?.notification.signal.removeEventListener("abort", queued.onAbort);
  }

  private dispatch(notification: ScreenContextNotification): void {
    if (!this.isCurrent(notification)) return;
    const run = { client: notification.client };
    this.active = run;
    void Promise.resolve()
      .then(() => {
        if (this.active !== run || !this.isCurrent(notification)) return;
        return notification.notify();
      })
      .catch(() => {
        // A voice reconnect/failure must not delay capture or expose provider error content.
      })
      .finally(() => {
        if (this.active !== run) return;
        this.active = null;
        const next = this.queued?.notification;
        this.clearQueued();
        if (next) this.dispatch(next);
      });
  }
}
