import type { ProductState } from '../../../shared/state.ts';

/** Spec tab of a product. Stub: the sparring chat and PRD editor replace it (own file on purpose). */
export function SpecTab({ product }: { product: ProductState }) {
  return <p>The spec chat and PRD editor for {product.name} will appear here.</p>;
}
