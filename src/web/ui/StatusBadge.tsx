export type BadgeTone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export interface StatusBadgeProps {
  tone: BadgeTone;
  /** The status in words; colour only reinforces it. */
  children: string;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}
