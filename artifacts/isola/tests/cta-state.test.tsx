import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CtaState } from '../components/foh/cta-panel';

// Proves the rendered service-error CTA state exposes: message, retry control,
// human-escalation link and the preserved correlation reference.
describe('CtaState — service error render', () => {
  const html = renderToStaticMarkup(
    <CtaState
      state={{ phase: 'error', code: 'SERVICE_UNAVAILABLE', msg: 'A service was temporarily unavailable. Your details are safe.', corr: 'cor_test_123', retry: () => {} }}
      reset={() => {}}
    />,
  );
  it('shows the service-error message', () => { expect(html).toContain('temporarily unavailable'); });
  it('shows a retry control', () => { expect(html).toContain('Try again'); });
  it('shows a human-escalation link', () => { expect(html).toMatch(/Message EPIC/); });
  it('preserves the correlation reference', () => { expect(html).toContain('cor_test_123'); });
});

describe('CtaState — success render', () => {
  const html = renderToStaticMarkup(<CtaState state={{ phase: 'success', corr: 'cor_ok_1' }} reset={() => {}} />);
  it('confirms receipt', () => { expect(html).toContain('Request received'); });
  it('preserves the correlation reference', () => { expect(html).toContain('cor_ok_1'); });
});
