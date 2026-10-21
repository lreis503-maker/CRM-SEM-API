import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/058_monthly_payment_reminders.sql',
);

describe('monthly payment reminder database contract', () => {
  it('defines the invariants required for safe recurring delivery', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/amount_cents\s+BIGINT\s+NOT NULL\s+CHECK\s*\(amount_cents\s*>\s*0\)/i);
    expect(sql).toMatch(/send_day\s+SMALLINT[\s\S]*BETWEEN\s+1\s+AND\s+31/i);
    expect(sql).toMatch(/UNIQUE\s*\(reminder_id,\s*competence\)/i);
    expect(sql).toMatch(/deleted_at\s+TIMESTAMPTZ/i);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/is_account_member\(account_id,\s*'admin'\)/i);
    expect(sql).toMatch(/created_by\s+UUID\s+REFERENCES\s+auth\.users\(id\)\s+ON DELETE SET NULL/i);
    expect(sql).not.toMatch(/created_by\s+UUID[\s\S]{0,80}REFERENCES\s+profiles\(id\)/i);
  });

  it('claims due work atomically and recovers abandoned claims', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/claim_due_monthly_payment_deliveries/i);
    expect(sql).toMatch(/FOR UPDATE(?: OF d)? SKIP LOCKED/i);
    expect(sql).toMatch(/processing_at\s*<\s*p_now\s*-\s*interval\s*'10 minutes'/i);
    expect(sql).toMatch(/next_attempt_at\s*<=\s*p_now/i);
    expect(sql).toMatch(/competence\s*=\s*date_trunc\('month',[\s\S]*p_now/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/i);
  });
});
