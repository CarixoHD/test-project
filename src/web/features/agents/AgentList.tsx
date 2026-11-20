import type { ProductState } from '../../../shared/state.ts';

/** The product's running agents and what they are doing. Stub: filled in by its own issue. */
export function AgentList({ product }: { product: ProductState }) {
  return (
    <section className="build-tab__slot" aria-label="Agents">
      <p>Agents working on {product.name} will appear here.</p>
    </section>
  );
}
