import { describe, expect, it } from 'vitest';

import { buildBusinessMdFromProfile, type DiscoveredBusinessProfile } from './business-facts-draft';

const FULL_PROFILE: DiscoveredBusinessProfile = {
  name: 'Aurora Boat Yard',
  industry: 'Marine repair and storage',
  description: 'Full-service boatyard offering haul-out, storage and repair.',
  phone: '+1 555-0100',
  email: 'info@aurorayard.example',
  location: { city: 'Portsmouth', country: 'Dominica' },
  hours: {
    monday: { open: '08:00', close: '17:00', closed: false },
    sunday: { open: null, close: null, closed: true },
  },
  services: ['Haul-out', 'Storage', 'Engine repair'],
  website: 'https://aurorayard.example',
  targetAudience: 'Recreational boat owners in the Eastern Caribbean',
  pricingTier: 'mid-range',
};

const MINIMAL_PROFILE: DiscoveredBusinessProfile = {
  name: 'Zephyr Kite School',
  industry: null,
  description: null,
  phone: null,
  email: null,
  location: null,
  hours: null,
  services: [],
  website: null,
  targetAudience: null,
  pricingTier: null,
};

describe('buildBusinessMdFromProfile — a fully-populated scan result', () => {
  const md = buildBusinessMdFromProfile(FULL_PROFILE);

  it('labels every sourced field SOURCED, not asserted as fact without the label', () => {
    expect(md).toContain('Aurora Boat Yard');
    expect(md).toContain('Portsmouth, Dominica');
    expect(md).toContain('Marine repair and storage');
    expect(md).toMatch(/Location:.*Portsmouth, Dominica.*SOURCED/);
  });

  it('lists every service, never inventing a price', () => {
    expect(md).toContain('Haul-out');
    expect(md).toContain('Storage');
    expect(md).toContain('Engine repair');
    expect(md).toContain('Not sourced — do not invent a figure');
    expect(md).not.toMatch(/\$\d/); // no dollar-figure anywhere — none was sourced
  });

  it('renders sourced hours as a table, not a guess', () => {
    expect(md).toContain('| Monday | 08:00–17:00 |');
    expect(md).toContain('| Sunday | Closed |');
  });

  it('renders the model-inferred fields under an explicit INFERRED heading', () => {
    expect(md).toContain('## Inferred (NOT sourced — do not present to a customer as fact)');
    expect(md).toContain('Recreational boat owners in the Eastern Caribbean');
    expect(md).toContain('INFERRED');
    expect(md).toContain('mid-range');
  });

  it('carries the provenance guardrail line verbatim', () => {
    expect(md).toContain('Never invent a figure for anything marked "not sourced"');
  });
});

describe('buildBusinessMdFromProfile — a name-only scan result (everything else missing)', () => {
  const md = buildBusinessMdFromProfile(MINIMAL_PROFILE);

  it('never fabricates a location, description, hours, price or contact route', () => {
    expect(md).toContain('Zephyr Kite School');
    expect(md).toContain('not established — left blank rather than invented');
    expect(md).toContain('No services listed by the scan. **Left blank rather than invented.**');
    expect(md).toContain('Not sourced. If asked, say hours are not confirmed here');
    expect(md).toContain('Not sourced. If asked, offer to connect the customer with a human');
  });

  it('omits the Inferred section entirely when the scan inferred nothing', () => {
    expect(md).not.toContain('## Inferred');
  });
});

describe('buildBusinessMdFromProfile — refuses an unnamed profile', () => {
  it('throws rather than emitting a BUSINESS.md with an invented or blank name', () => {
    expect(() => buildBusinessMdFromProfile({ ...MINIMAL_PROFILE, name: '   ' })).toThrow(
      /name is required/,
    );
  });
});

describe('buildBusinessMdFromProfile — equivalence with EPIC\'s existing owner-reviewed draft', () => {
  // NOT a second EPIC draft. This constructs the profile a real discovery scan of
  // EPIC would produce from facts already sourced and owner-reviewed in PR #140's
  // artifacts/isola/charters/pending/NEW-5c3277f0-BUSINESS.md, and checks this
  // reusable converter reproduces content consistent with that single canonical
  // draft — proving the connection, not creating a competing artifact.
  const EPIC_PROFILE: DiscoveredBusinessProfile = {
    name: 'EPIC Communications Inc.',
    industry: 'Telecommunications and IT services',
    description: 'Internet connectivity, voice/VoIP telephony, and WhatsApp-based customer support and sales.',
    phone: null,
    email: null,
    location: { city: 'Roseau', country: 'Dominica' },
    hours: null,
    services: ['Internet connectivity', 'VoIP / telephony', 'WhatsApp customer support & sales'],
    website: null,
    targetAudience: 'Likely residential and small-business customers in Dominica and the wider Eastern Caribbean',
    pricingTier: 'value/mid-market local ISP and telecom provider',
  };

  const md = buildBusinessMdFromProfile(EPIC_PROFILE, {
    contactRouteGuidance:
      'WhatsApp: `+1 767 818 0001` (Personal Line Concierge). For general sales/support, use the ' +
      'WhatsApp number this conversation is already running on.',
  });

  it('reproduces the same SOURCED facts as the canonical PR #140 draft', () => {
    expect(md).toContain('EPIC Communications Inc.');
    expect(md).toContain('Roseau, Dominica');
    expect(md).toContain('Internet connectivity');
    expect(md).toContain('VoIP / telephony');
    expect(md).toContain('WhatsApp customer support & sales');
    expect(md).toContain('+1 767 818 0001');
    expect(md).toContain('SOURCED');
    expect(md).toContain('INFERRED');
    expect(md).toContain('Do not invent a figure');
  });

  it('never states a price, plan tier figure, or hours EPIC has not sourced', () => {
    expect(md).not.toMatch(/\$\d/);
    expect(md).toContain('Not sourced. If asked, say hours are not confirmed here');
  });
});
