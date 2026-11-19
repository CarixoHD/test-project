import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App } from './App.tsx';
import { routes } from './routes.tsx';
import { createAppStore } from './state/store.ts';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('index.html is missing the #root element');

const store = createAppStore();
const router = createBrowserRouter(routes);

createRoot(container).render(
  <StrictMode>
    <App store={store} router={router} />
  </StrictMode>,
);
