import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

// ARIA tabs (WAI-ARIA APG, automatic activation): one tab stop for the whole list, arrow keys
// move and select, Home/End jump to the ends. Unselected panels stay mounted but hidden so
// their state (e.g. a paused 3D scene) survives switching.

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tab list. */
  label: string;
  items: readonly TabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function Tabs({ label, items, selectedId, onSelect }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  function select(index: number) {
    const item = items[(index + items.length) % items.length];
    if (item === undefined) return;
    onSelect(item.id);
    tabRefs.current.get(item.id)?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const targets: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: items.length - 1,
    };
    const target = targets[e.key];
    if (target === undefined) return;
    e.preventDefault();
    select(target);
  }

  return (
    <div className="ui-tabs">
      <div role="tablist" aria-label={label} className="ui-tabs__list">
        {items.map((item, index) => {
          const isSelected = item.id === selectedId;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el === null) tabRefs.current.delete(item.id);
                else tabRefs.current.set(item.id, el);
              }}
              type="button"
              role="tab"
              id={tabId(item.id)}
              className="ui-tabs__tab"
              aria-selected={isSelected}
              aria-controls={panelId(item.id)}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(item.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={panelId(item.id)}
          aria-labelledby={tabId(item.id)}
          className="ui-tabs__panel"
          hidden={item.id !== selectedId}
          // APG: a panel without focusable content must itself be reachable by Tab.
          tabIndex={0}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}
