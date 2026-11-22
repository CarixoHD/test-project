import { useLocation, useNavigate, useParams } from 'react-router';
import { ProductIdSchema } from '../../../shared/ids.ts';
import type { ProductState } from '../../../shared/state.ts';
import { useApp } from '../../state/store.ts';
import { StatusBadge, Tabs, type TabItem } from '../../ui/index.ts';
import { BuildTab } from '../board/BuildTab.tsx';
import { ProductSettingsTab } from '../settings/ProductSettingsTab.tsx';
import { SpecTab } from '../sparring/SpecTab.tsx';
import type { CreatedLocationState } from './NewProductForm.tsx';
import { PHASE_LABELS, PHASE_TONES } from './phase.ts';

const TAB_IDS = ['build', 'spec', 'settings'] as const;

// Each tab is its own component file, so the features that fill them in replace one file.
const tabs = (product: ProductState): readonly TabItem[] => [
  { id: 'build', label: 'Build', content: <BuildTab product={product} /> },
  { id: 'spec', label: 'Spec', content: <SpecTab product={product} /> },
  { id: 'settings', label: 'Settings', content: <ProductSettingsTab product={product} /> },
];

const isJustCreated = (state: unknown): boolean =>
  typeof state === 'object' &&
  state !== null &&
  (state as Partial<CreatedLocationState>).created === true;

/** `/products/:id/*`: one product, with its tab in the rest of the path (default: build). */
export function ProductPage() {
  const { id = '', '*': rest = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const productId = ProductIdSchema.safeParse(id).data;
  const product = useApp((s) => (productId ? s.state.products[productId] : undefined));
  const loaded = useApp((s) => s.loaded);

  if (product === undefined) {
    if (!loaded) return <h1>Loading product…</h1>;
    // Right after creation the product.created event may still be on its way over SSE.
    return <h1>{isJustCreated(location.state) ? 'Opening product…' : 'Product not found'}</h1>;
  }
  const tab = TAB_IDS.find((t) => t === rest) ?? 'build';
  return (
    <>
      <header className="product-header">
        <h1>{product.name}</h1>
        <StatusBadge tone={PHASE_TONES[product.phase]}>{PHASE_LABELS[product.phase]}</StatusBadge>
      </header>
      <Tabs
        label="Product views"
        items={tabs(product)}
        selectedId={tab}
        onSelect={(next) => navigate(`/products/${id}${next === 'build' ? '' : `/${next}`}`)}
      />
    </>
  );
}
