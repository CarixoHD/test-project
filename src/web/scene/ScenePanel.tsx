import type { ProductState } from '../../shared/state.ts';

/** Collapsible 3D construction-site view. Stub: filled in by its own issue. */
export function ScenePanel({ product }: { product: ProductState }) {
  return (
    <section className="build-tab__slot" aria-label="3D view">
      <p>The 3D construction site of {product.name} will appear here.</p>
    </section>
  );
}
