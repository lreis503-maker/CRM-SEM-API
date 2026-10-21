export const COLD_PROSPECT_STATUSES = [
  'new',
  'contacted',
  'replied',
  'interested',
  'no_response',
  'not_interested',
] as const;

export type ColdProspectStatus = (typeof COLD_PROSPECT_STATUSES)[number];

export interface ColdProspect {
  id: string;
  account_id: string;
  created_by: string;
  assigned_to: string | null;
  name: string;
  instagram: string | null;
  whatsapp: string | null;
  company: string | null;
  niche: string | null;
  source: string | null;
  status: ColdProspectStatus;
  attempt_count: number;
  last_contact_at: string | null;
  next_follow_up_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProspectInput {
  name: string;
  instagram: string;
  whatsapp: string;
}

export type ProspectValidation =
  | { valid: true }
  | {
      valid: false;
      error:
        | 'name_required'
        | 'contact_channel_required'
        | 'instagram_invalid'
        | 'whatsapp_invalid';
    };

export function normalizeInstagram(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^@+/, '')
    .trim();
}

export function normalizeWhatsApp(value: string): string {
  return value.replace(/\D/g, '');
}

export function validateProspectInput(
  input: ProspectInput
): ProspectValidation {
  if (!input.name.trim()) return { valid: false, error: 'name_required' };
  const instagram = normalizeInstagram(input.instagram);
  const whatsapp = normalizeWhatsApp(input.whatsapp);
  if (!instagram && !whatsapp) {
    return { valid: false, error: 'contact_channel_required' };
  }
  if (instagram && !/^[a-zA-Z0-9._]{1,30}$/.test(instagram)) {
    return { valid: false, error: 'instagram_invalid' };
  }
  if (whatsapp && !/^\d{10,15}$/.test(whatsapp)) {
    return { valid: false, error: 'whatsapp_invalid' };
  }
  return { valid: true };
}

export function buildAttemptUpdate(
  prospect: Pick<ColdProspect, 'attempt_count' | 'status'>,
  contactedAt: string
): Pick<ColdProspect, 'attempt_count' | 'last_contact_at' | 'status'> {
  return {
    attempt_count: prospect.attempt_count + 1,
    last_contact_at: contactedAt,
    status: prospect.status === 'new' ? 'contacted' : prospect.status,
  };
}

export interface ProspectMetrics {
  total: number;
  contacted: number;
  replied: number;
  interested: number;
  overdue: number;
  responseRate: number;
}

const REPLIED_STATUSES: ReadonlySet<ColdProspectStatus> = new Set([
  'replied',
  'interested',
]);

export function calculateProspectMetrics(
  prospects: ColdProspect[],
  now = new Date()
): ProspectMetrics {
  const contacted = prospects.filter(
    (prospect) => prospect.status !== 'new'
  ).length;
  const replied = prospects.filter((prospect) =>
    REPLIED_STATUSES.has(prospect.status)
  ).length;
  const interested = prospects.filter(
    (prospect) => prospect.status === 'interested'
  ).length;
  const overdue = prospects.filter(
    (prospect) =>
      prospect.next_follow_up_at !== null &&
      new Date(prospect.next_follow_up_at).getTime() < now.getTime() &&
      prospect.status !== 'not_interested'
  ).length;

  return {
    total: prospects.length,
    contacted,
    replied,
    interested,
    overdue,
    responseRate: contacted === 0 ? 0 : Math.round((replied / contacted) * 100),
  };
}
