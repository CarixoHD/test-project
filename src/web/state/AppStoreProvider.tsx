import { useEffect, type ReactNode } from 'react';
import { AppStoreContext, type AppStore } from './store.ts';

/** Provides `store` to `useApp` and keeps it connected while mounted. */
export function AppStoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  useEffect(() => store.start(), [store]);
  return <AppStoreContext value={store}>{children}</AppStoreContext>;
}
