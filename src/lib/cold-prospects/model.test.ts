import { describe, expect, it } from 'vitest';

import {
  buildAttemptUpdate,
  calculateProspectMetrics,
  normalizeInstagram,
  normalizeWhatsApp,
  validateProspectInput,
  type ColdProspect,
} from './model';

const baseProspect: ColdProspect = {
  id: 'prospect-1',
  account_id: 'account-1',
  created_by: 'user-1',
  assigned_to: null,
  name: 'Ana Lima',
  instagram: 'analima',
  whatsapp: '5511999999999',
  company: null,
  niche: null,
  source: null,
  status: 'new',
  attempt_count: 0,
  last_contact_at: null,
  next_follow_up_at: null,
  notes: null,
  created_at: '2026-10-20T12:00:00.000Z',
  updated_at: '2026-10-20T12:00:00.000Z',
};

describe('normalizeInstagram', () => {
  it('turns an Instagram URL or @handle into a clean handle', () => {
    expect(
      normalizeInstagram(' https://instagram.com/@ana.lima/?hl=pt-br ')
    ).toBe('ana.lima');
    expect(normalizeInstagram('@ana_lima')).toBe('ana_lima');
  });
});

describe('normalizeWhatsApp', () => {
  it('keeps only the international number digits', () => {
    expect(normalizeWhatsApp('+55 (11) 99999-9999')).toBe('5511999999999');
  });
});

describe('validateProspectInput', () => {
  it('requires a name and at least one contact channel', () => {
    expect(
      validateProspectInput({ name: '', instagram: '', whatsapp: '' })
    ).toEqual({
      valid: false,
      error: 'name_required',
    });
    expect(
      validateProspectInput({ name: 'Ana', instagram: '', whatsapp: '' })
    ).toEqual({ valid: false, error: 'contact_channel_required' });
  });

  it('accepts either Instagram or WhatsApp', () => {
    expect(
      validateProspectInput({ name: 'Ana', instagram: '@ana', whatsapp: '' })
    ).toEqual({ valid: true });
    expect(
      validateProspectInput({
        name: 'Ana',
        instagram: '',
        whatsapp: '+5511999999999',
      })
    ).toEqual({ valid: true });
  });

  it('rejects malformed Instagram handles and WhatsApp numbers', () => {
    expect(
      validateProspectInput({
        name: 'Ana',
        instagram: 'ana lima!',
        whatsapp: '',
      })
    ).toEqual({ valid: false, error: 'instagram_invalid' });
    expect(
      validateProspectInput({ name: 'Ana', instagram: '', whatsapp: '12345' })
    ).toEqual({ valid: false, error: 'whatsapp_invalid' });
  });
});

describe('buildAttemptUpdate', () => {
  it('increments attempts, records the contact time and moves a new lead to contacted', () => {
    expect(
      buildAttemptUpdate(baseProspect, '2026-10-21T14:30:00.000Z')
    ).toEqual({
      attempt_count: 1,
      last_contact_at: '2026-10-21T14:30:00.000Z',
      status: 'contacted',
    });
  });

  it('preserves a later funnel status', () => {
    expect(
      buildAttemptUpdate(
        { ...baseProspect, status: 'interested', attempt_count: 2 },
        '2026-10-21T14:30:00.000Z'
      )
    ).toEqual({
      attempt_count: 3,
      last_contact_at: '2026-10-21T14:30:00.000Z',
      status: 'interested',
    });
  });
});

describe('calculateProspectMetrics', () => {
  it('calculates operational totals and overdue follow-ups', () => {
    const prospects: ColdProspect[] = [
      baseProspect,
      {
        ...baseProspect,
        id: 'prospect-2',
        status: 'replied',
        next_follow_up_at: '2026-10-20T12:00:00.000Z',
      },
      {
        ...baseProspect,
        id: 'prospect-3',
        status: 'interested',
        next_follow_up_at: '2026-10-22T12:00:00.000Z',
      },
      { ...baseProspect, id: 'prospect-4', status: 'not_interested' },
    ];

    expect(
      calculateProspectMetrics(prospects, new Date('2026-10-21T12:00:00.000Z'))
    ).toEqual({
      total: 4,
      contacted: 3,
      replied: 2,
      interested: 1,
      overdue: 1,
      responseRate: 67,
    });
  });
});
