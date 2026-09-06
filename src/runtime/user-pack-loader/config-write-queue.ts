import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";

/** Serialize config read-modify-writes from old and current App instances. */
export function enqueueConfigWrite<T>(write: () => Promise<T>): Promise<T> {
  const queue = getOrInit(KEYS.CONFIG_WRITE_QUEUE, () => ({ pending: Promise.resolve() }));
  const next = queue.pending.then(write);
  queue.pending = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
