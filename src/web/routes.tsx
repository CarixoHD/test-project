import type { RouteObject } from 'react-router';
import { InboxPage } from './features/inbox/InboxPage.tsx';
import { IssuePage } from './features/issues/IssuePage.tsx';
import { ProductPage } from './features/products/ProductPage.tsx';
import { ProductsPage } from './features/products/ProductsPage.tsx';
import { SettingsPage } from './features/settings/SettingsPage.tsx';
import { Layout } from './Layout.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';

// ARCHITECTURE §4.12. `/products/:id/*` holds the product tabs (build, spec, settings).
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: '/', element: <ProductsPage /> },
      { path: '/products/:id/issues/:issueId', element: <IssuePage /> },
      { path: '/products/:id/*', element: <ProductPage /> },
      { path: '/inbox', element: <InboxPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
