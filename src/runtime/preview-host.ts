export interface PreviewStatus {
  detached: boolean;
  opening: boolean;
  error?: string;
}
export interface PreviewAction {
  leaseId: string;
  action: "stop" | "attach";
}
export interface PreviewTransport<Frame> {
  begin: () => Promise<string>;
  open: (leaseId: string) => Promise<void>;
  /** Reveal an existing window only after an explicit user action. */
  show?: (leaseId: string) => Promise<void>;
  revoke: (leaseId: string) => Promise<void>;
  publish: (frame: Frame) => Promise<void>;
  listen: (callback: (action: PreviewAction) => void) => Promise<() => void>;
}
export interface PreviewOptions {
  visible?: boolean;
  initiallyDetached?: boolean;
  onStop: () => void;
}
export interface PreviewLifecycle {
  pending: Promise<void>;
}
interface Attempt<Source> {
  source: Source;
  leaseId?: string;
  cancelled: boolean;
  cleanup?: () => void;
}
interface PreviewAdapter<Model, Source, Frame> {
  source: (model: Model) => Source | null;
  ready: (model: Model) => boolean;
  relay: (
    source: Source,
    model: () => Model,
    leaseId: string,
    publish: (frame: Frame) => Promise<void>,
    fail: (error: unknown) => void,
  ) => () => void;
}
/** Owns the destination for a source session; visibility only controls native resources. */
export class PreviewHost<Model extends PreviewOptions, Source, Frame> {
  private attempt: Attempt<Source> | null = null;
  private disposed = false;
  private detached: boolean;
  private failed = false;
  private unlisten?: () => void;
  private listening?: Promise<void>;
  constructor(
    private model: Model,
    private readonly changed: (state: PreviewStatus) => void,
    private readonly transport: PreviewTransport<Frame>,
    private readonly adapter: PreviewAdapter<Model, Source, Frame>,
    private readonly lifecycle: PreviewLifecycle,
  ) {
    this.detached = model.initiallyDetached ?? false;
  }
  /** Rendering follows the chosen destination, including before update effects run. */
  isInline(model: Model): boolean {
    if (model.visible === false || !this.adapter.source(model)) return false;
    if (this.adapter.source(this.model) !== this.adapter.source(model)) {
      return !(model.initiallyDetached ?? false);
    }
    return !this.detached || (this.failed && this.model.visible !== false);
  }
  update(model: Model): void {
    const replaced = this.adapter.source(this.model) !== this.adapter.source(model);
    const shown = this.model.visible === false && model.visible !== false;
    this.model = model;
    if (replaced) {
      this.detached = model.initiallyDetached ?? false;
      this.failed = false;
      void this.close().catch(() => {});
    } else if (shown) {
      this.failed = false;
    }
    if (model.visible === false || !this.adapter.source(model)) {
      if (this.attempt) void this.close().catch(() => {});
    } else if (this.detached && !this.failed && this.adapter.ready(model)) {
      void this.open().catch(() => {});
    }
  }
  private current(attempt: Attempt<Source>): boolean {
    return (
      !this.disposed &&
      !attempt.cancelled &&
      this.attempt === attempt &&
      this.adapter.source(this.model) === attempt.source
    );
  }
  private async ensureListening(): Promise<void> {
    if (this.unlisten) return;
    if (!this.listening) {
      this.listening = this.transport
        .listen((request) => {
          const attempt = this.attempt;
          if (!attempt || !this.current(attempt) || request.leaseId !== attempt.leaseId) return;
          if (request.action !== "attach" && request.action !== "stop") return;
          void this.attach().catch(() => {});
          if (request.action === "stop") this.model.onStop();
        })
        .then((unlisten) => {
          if (this.disposed) unlisten();
          else this.unlisten = unlisten;
        })
        .catch((error: unknown) => {
          this.listening = undefined;
          throw error;
        });
    }
    await this.listening;
  }
  detach(): Promise<void> {
    this.detached = true;
    this.failed = false;
    const opening = this.open();
    const attempt = this.attempt;
    const ready = this.lifecycle.pending;
    return opening.then(async () => {
      // An automatic open may already be in progress. Preserve this exact owner while
      // waiting, so a late click cannot focus a replacement session's window.
      await ready;
      if (!attempt?.leaseId || !this.current(attempt) || !this.transport.show) return;
      try {
        await this.transport.show(attempt.leaseId);
        if (this.current(attempt)) this.changed({ detached: true, opening: false });
      } catch (error) {
        if (!this.current(attempt)) return;
        this.changed({ detached: true, opening: false, error: String(error) });
        throw error;
      }
    });
  }
  private open(): Promise<void> {
    const source = this.adapter.source(this.model);
    if (
      this.disposed ||
      !source ||
      this.model.visible === false ||
      this.attempt ||
      !this.adapter.ready(this.model)
    )
      return Promise.resolve();
    const attempt: Attempt<Source> = { source, cancelled: false };
    this.attempt = attempt;
    this.changed({ detached: false, opening: true });
    const operation = this.lifecycle.pending
      .catch(() => {})
      .then(async () => {
        try {
          if (!this.current(attempt)) return;
          await this.ensureListening();
          if (!this.current(attempt)) return;
          attempt.leaseId = await this.transport.begin();
          if (!this.current(attempt)) {
            await this.transport.revoke(attempt.leaseId);
            return;
          }
          await this.transport.open(attempt.leaseId);
          if (!this.current(attempt)) {
            await this.transport.revoke(attempt.leaseId);
            return;
          }
          const cleanup = this.adapter.relay(
            attempt.source,
            () => this.model,
            attempt.leaseId,
            (frame) => (this.current(attempt) ? this.transport.publish(frame) : Promise.resolve()),
            (error) => {
              if (!this.current(attempt)) return;
              this.failed = true;
              void this.close().catch(() => {});
              this.changed({ detached: false, opening: false, error: String(error) });
            },
          );
          if (!this.current(attempt)) {
            cleanup();
            return;
          }
          attempt.cleanup = cleanup;
          this.changed({ detached: true, opening: false });
        } catch (error) {
          const wasCurrent = this.current(attempt);
          attempt.cancelled = true;
          attempt.cleanup?.();
          if (this.attempt === attempt) this.attempt = null;
          if (wasCurrent) this.failed = true;
          if (attempt.leaseId) await this.transport.revoke(attempt.leaseId).catch(() => {});
          if (wasCurrent && !this.disposed && !this.attempt) {
            this.changed({ detached: false, opening: false, error: String(error) });
            throw error;
          }
        }
      });
    this.lifecycle.pending = operation.catch(() => {});
    return operation;
  }
  attach(): Promise<void> {
    this.detached = false;
    this.failed = false;
    return this.close();
  }
  private close(): Promise<void> {
    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) {
      attempt.cancelled = true;
      attempt.cleanup?.();
    }
    if (!this.disposed) this.changed({ detached: false, opening: false });
    // Revoke immediately while pending creation is fenced, then serialize the next owner.
    const revoke = attempt?.leaseId ? this.transport.revoke(attempt.leaseId) : Promise.resolve();
    const operation = Promise.all([this.lifecycle.pending, revoke]).then(() => {});
    this.lifecycle.pending = operation.catch(() => {});
    return operation;
  }
  dispose(): void {
    this.disposed = true;
    void this.close().catch(() => {});
    this.unlisten?.();
    this.unlisten = undefined;
  }
}
