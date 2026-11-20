import type { ProductPhase } from '../../../shared/domain.ts';
import type { BadgeTone } from '../../ui/index.ts';

/** A product phase in words, as shown in the product list and the product header. */
export const PHASE_LABELS: Record<ProductPhase, string> = {
  sparring: 'Sparring',
  building: 'Building',
  complete: 'Complete',
};

export const PHASE_TONES: Record<ProductPhase, BadgeTone> = {
  sparring: 'info',
  building: 'progress',
  complete: 'success',
};
