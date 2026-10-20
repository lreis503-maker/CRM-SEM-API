import type { ReminderScheduleInput } from './types';

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsAt(date: Date, timeZone: string): CalendarParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export function scheduledInstant(input: {
  year: number;
  month: number;
  sendDay: number;
  sendTime: string;
  timeZone: string;
}): Date {
  if (!TIME_PATTERN.test(input.sendTime)) throw new Error('Horário inválido');
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
    throw new Error('Mês inválido');
  }
  if (!Number.isInteger(input.sendDay) || input.sendDay < 1 || input.sendDay > 31) {
    throw new Error('Dia inválido');
  }

  const [hour, minute] = input.sendTime.split(':').map(Number);
  const day = Math.min(input.sendDay, daysInMonth(input.year, input.month));
  const desiredUtcShape = Date.UTC(input.year, input.month - 1, day, hour, minute, 0);
  let candidate = new Date(desiredUtcShape);

  // Resolve the IANA offset at the target date. A second pass covers an
  // offset transition between the initial UTC-shaped guess and the target.
  for (let pass = 0; pass < 2; pass++) {
    const local = partsAt(candidate, input.timeZone);
    const representedAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    candidate = new Date(candidate.getTime() + (desiredUtcShape - representedAsUtc));
  }
  return candidate;
}

export function firstEligibleCompetence(input: ReminderScheduleInput & { now: Date }): string {
  const local = partsAt(input.now, input.timeZone);
  const current = scheduledInstant({ year: local.year, month: local.month, ...input });
  const selected = input.now.getTime() <= current.getTime()
    ? { year: local.year, month: local.month }
    : addMonth(local.year, local.month);
  return `${selected.year}-${String(selected.month).padStart(2, '0')}-01`;
}

export function nextScheduledInstant(
  input: ReminderScheduleInput & { after: Date; startsAt: Date },
): Date {
  let { year, month } = partsAt(input.after, input.timeZone);
  for (let attempt = 0; attempt < 36; attempt++) {
    const candidate = scheduledInstant({ year, month, ...input });
    if (candidate > input.after && candidate >= input.startsAt) return candidate;
    ({ year, month } = addMonth(year, month));
  }
  throw new Error('Não foi possível calcular o próximo envio');
}

