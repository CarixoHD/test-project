import type { ProductState } from '../../../shared/state.ts';
import { PrdPanel } from './PrdPanel.tsx';
import { SparringChat } from './SparringChat.tsx';

/** Spec tab of a product: the sparring chat next to the live PRD draft. */
export function SpecTab({ product }: { product: ProductState }) {
  return (
    <div className="spec-tab">
      <SparringChat productId={product.id} />
      <PrdPanel productId={product.id} />
    </div>
  );
}
