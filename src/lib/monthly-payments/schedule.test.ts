import { describe, expect, it } from 'vitest';

import {
  firstEligibleCompetence,
  nextScheduledInstant,
  scheduledInstant,
} from './schedule';

const ZONE = 'America/Sao_Paulo';

describe('scheduledInstant', () => {
  it('uses the last day when day 31 does not exist', () => {
    expect(
      scheduledInstant({ year: 2027, month: 2, sendDay: 31, sendTime: '09:00', timeZone: ZONE }),
    ).toEqual(new Date('2027-02-28T12:00:00.000Z'));
  });

  it('keeps February 29 in a leap year', () => {
    expect(
      scheduledInstant({ year: 2028, month: 2, sendDay: 29, sendTime: '09:00', timeZone: ZONE }),
    ).toEqual(new Date('2028-02-29T12:00:00.000Z'));
  });

  it('rejects an invalid time', () => {
    expect(() =>
      scheduledInstant({ year: 2026, month: 10, sendDay: 10, sendTime: '25:00', timeZone: ZONE }),
    ).toThrow('Horário inválido');
  });
});

describe('firstEligibleCompetence', () => {
  it('starts in the current month when created before the scheduled instant', () => {
    expect(
      firstEligibleCompetence({
        now: new Date('2026-10-20T11:59:00.000Z'),
        sendDay: 20,
        sendTime: '09:00',
        timeZone: ZONE,
      }),
    ).toBe('2026-10-01');
  });

  it('starts next month when created after the scheduled instant', () => {
    expect(
      firstEligibleCompetence({
        now: new Date('2026-10-20T12:01:00.000Z'),
        sendDay: 20,
        sendTime: '09:00',
        timeZone: ZONE,
      }),
    ).toBe('2026-11-01');
  });
});

describe('nextScheduledInstant', () => {
  it('returns the next eligible local schedule independently of the host timezone', () => {
    expect(
      nextScheduledInstant({
        after: new Date('2026-10-31T23:30:00.000Z'),
        startsAt: new Date('2026-10-20T10:00:00.000Z'),
        sendDay: 31,
        sendTime: '09:00',
        timeZone: ZONE,
      }),
    ).toEqual(new Date('2026-11-30T12:00:00.000Z'));
  });
});

