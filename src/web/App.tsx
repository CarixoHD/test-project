import { RouterProvider, type createBrowserRouter } from 'react-router';
import { AppStoreProvider } from './state/AppStoreProvider.tsx';
import type { AppStore } from './state/store.ts';

export type AppRouter = ReturnType<typeof createBrowserRouter>;

/** The SPA root: the live store around the router (see routes.tsx). */
export function App({ store, router }: { store: AppStore; router: AppRouter }) {
  return (
    <AppStoreProvider store={store}>
      <RouterProvider router={router} />
    </AppStoreProvider>
  );
}
