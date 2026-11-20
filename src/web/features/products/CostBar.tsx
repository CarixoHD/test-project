import type { ProductState } from '../../../shared/state.ts';

/** Spend against the product budget. Stub: filled in by its own issue. */
export function CostBar({ product }: { product: ProductState }) {
  return (
    <section className="build-tab__slot" aria-label="Costs">
      <p>Costs for {product.name} will appear here.</p>
    </section>
  );
}
