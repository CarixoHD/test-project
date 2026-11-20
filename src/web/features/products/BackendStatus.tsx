import type { ProductState } from '../../../shared/state.ts';

/** Rate-limit and availability state of the agent backends. Stub: filled in by its own issue. */
export function BackendStatus({ product }: { product: ProductState }) {
  return (
    <section className="build-tab__slot" aria-label="Backend status">
      <p>Backend status for {product.name} will appear here.</p>
    </section>
  );
}
