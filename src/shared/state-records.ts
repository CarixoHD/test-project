// Immutable helpers for the id-keyed records in ClientState.

/** Returns `rec` with `rec[id]` replaced by `fn(rec[id])`; unchanged when `id` is absent. */
export function patch<K extends string, V>(
  rec: Record<K, V>,
  id: K,
  fn: (v: V) => V,
): Record<K, V> {
  const cur = rec[id];
  return cur === undefined || !Object.hasOwn(rec, id) ? rec : { ...rec, [id]: fn(cur) };
}

/** Returns `rec` without `id`; unchanged when `id` is absent. */
export function without<V>(rec: Record<string, V>, id: string): Record<string, V> {
  if (!Object.hasOwn(rec, id)) return rec;
  return Object.fromEntries(Object.entries<V>(rec).filter(([key]) => key !== id));
}
