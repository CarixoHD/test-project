import { useNavigate, useParams } from 'react-router';
import { ProductIdSchema } from '../../../shared/ids.ts';
import { useApp } from '../../state/store.ts';
import { Tabs, type TabItem } from '../../ui/index.ts';

const TABS: readonly TabItem[] = [
  { id: 'build', label: 'Build', content: <p>The board, agents and costs will appear here.</p> },
  { id: 'spec', label: 'Spec', content: <p>The spec chat and PRD editor will appear here.</p> },
  { id: 'settings', label: 'Settings', content: <p>Product settings will appear here.</p> },
];

/** `/products/:id/*`: one product, with its tab in the rest of the path (default: build). */
export function ProductPage() {
  const { id = '', '*': rest = '' } = useParams();
  const navigate = useNavigate();
  const productId = ProductIdSchema.safeParse(id).data;
  const product = useApp((s) => (productId ? s.state.products[productId] : undefined));
  const loaded = useApp((s) => s.loaded);

  if (product === undefined) {
    return <h1>{loaded ? 'Product not found' : 'Loading product…'}</h1>;
  }
  const tab = TABS.some((t) => t.id === rest) ? rest : 'build';
  return (
    <>
      <h1>{product.name}</h1>
      <Tabs
        label="Product views"
        items={TABS}
        selectedId={tab}
        onSelect={(next) => navigate(`/products/${id}${next === 'build' ? '' : `/${next}`}`)}
      />
    </>
  );
}
