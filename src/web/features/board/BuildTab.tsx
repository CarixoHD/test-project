import type { ProductState } from '../../../shared/state.ts';

/** Build tab of a product. Stub: the board, agent list and costs replace it (own file on purpose). */
export function BuildTab({ product }: { product: ProductState }) {
  return <p>The board, agents and costs of {product.name} will appear here.</p>;
}
