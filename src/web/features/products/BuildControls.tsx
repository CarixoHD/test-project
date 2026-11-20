import type { ProductState } from '../../../shared/state.ts';

/** Pause/resume and preview controls of the Build tab. Stub: filled in by its own issue. */
export function BuildControls({ product }: { product: ProductState }) {
  return (
    <section className="build-tab__slot" aria-label="Build controls">
      <p>Pause, resume and preview for {product.name} will appear here.</p>
    </section>
  );
}
