import { describe, expect, it, vi } from 'vitest';

import {
  prepareProviderSwitch,
  switchAccountToUazapi,
} from './provider-switch';

type Rows = Record<string, Array<Record<string, unknown>>>;

interface RecordedFilter {
  table: string;
  method: 'eq' | 'in';
  column: string;
  value: unknown;
}

function fakeDb(rows: Rows, rpcResult?: { data?: unknown; error?: unknown }) {
  const tables: string[] = [];
  const filters: RecordedFilter[] = [];
  const rpc = vi.fn().mockResolvedValue({
    data: rpcResult?.data ?? null,
    error: rpcResult?.error ?? null,
  });

  const db = {
    from(table: string) {
      tables.push(table);
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push({ table, method: 'eq', column, value });
          return query;
        },
        in: (column: string, value: unknown) => {
          filters.push({ table, method: 'in', column, value });
          return query;
        },
        then: (
          resolve: (result: { data: unknown; error: unknown }) => unknown
        ) => resolve({ data: rows[table] ?? [], error: null }),
      };
      return query;
    },
    rpc,
  };

  return { db, tables, filters, rpc };
}

const FULL_ROWS: Rows = {
  broadcasts: [{ id: 'b-1' }, { id: 'b-2' }],
  automations: [{ id: 'a-1' }, { id: 'a-2' }],
  automation_steps: [{ automation_id: 'a-1' }, { automation_id: 'a-1' }],
  flows: [{ id: 'f-1' }, { id: 'f-2' }],
  flow_nodes: [{ flow_id: 'f-2' }],
  flow_runs: [{ id: 'r-1' }, { id: 'r-2' }],
};

describe('prepareProviderSwitch', () => {
  it('counts the work UAZAPI cannot run without changing anything', async () => {
    const { db, tables } = fakeDb(FULL_ROWS);

    const counts = await prepareProviderSwitch(db, 'acc-1');

    expect(counts).toEqual({
      cancelledBroadcasts: 2,
      deactivatedAutomations: 1,
      draftedFlows: 1,
      stoppedFlowRuns: 2,
    });
    expect(tables).toEqual([
      'broadcasts',
      'automations',
      'automation_steps',
      'flows',
      'flow_nodes',
      'flow_runs',
    ]);
  });

  it('scopes every read to the account and the incompatible definitions', async () => {
    const { db, filters } = fakeDb(FULL_ROWS);

    await prepareProviderSwitch(db, 'acc-1');

    expect(filters).toContainEqual({
      table: 'broadcasts',
      method: 'in',
      column: 'status',
      value: ['scheduled', 'sending'],
    });
    expect(filters).toContainEqual({
      table: 'automation_steps',
      method: 'eq',
      column: 'step_type',
      value: 'send_template',
    });
    expect(filters).toContainEqual({
      table: 'flow_nodes',
      method: 'in',
      column: 'node_type',
      value: ['send_buttons', 'send_list'],
    });
    for (const table of ['broadcasts', 'automations', 'flows', 'flow_runs']) {
      expect(filters).toContainEqual({
        table,
        method: 'eq',
        column: 'account_id',
        value: 'acc-1',
      });
    }
  });

  it('skips the dependent lookups when nothing is active', async () => {
    const { db, tables } = fakeDb({});

    const counts = await prepareProviderSwitch(db, 'acc-1');

    expect(counts).toEqual({
      cancelledBroadcasts: 0,
      deactivatedAutomations: 0,
      draftedFlows: 0,
      stoppedFlowRuns: 0,
    });
    expect(tables).toEqual(['broadcasts', 'automations', 'flows']);
  });
});

describe('switchAccountToUazapi', () => {
  const input = {
    accountId: 'acc-1',
    userId: 'user-1',
    instanceId: 'i-1',
    instanceName: 'wacrm-acc1-a1b2',
    encryptedInstanceToken: 'aa:bb:cc',
    webhookSecretHash: 'f'.repeat(64),
    connectionAttemptId: '11111111-1111-4111-8111-111111111111',
  };

  it('delegates the whole switch to the transactional RPC', async () => {
    const { db, rpc } = fakeDb(
      {},
      {
        data: {
          config_id: 'cfg-1',
          cancelled_broadcasts: 2,
          deactivated_automations: 1,
          drafted_flows: 1,
          stopped_flow_runs: 3,
        },
      }
    );

    const result = await switchAccountToUazapi(db, input);

    expect(rpc).toHaveBeenCalledWith('switch_account_to_uazapi', {
      p_account_id: 'acc-1',
      p_user_id: 'user-1',
      p_instance_id: 'i-1',
      p_instance_name: 'wacrm-acc1-a1b2',
      p_encrypted_instance_token: 'aa:bb:cc',
      p_webhook_secret_hash: 'f'.repeat(64),
      p_connection_attempt_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(result).toEqual({
      configId: 'cfg-1',
      cancelledBroadcasts: 2,
      deactivatedAutomations: 1,
      draftedFlows: 1,
      stoppedFlowRuns: 3,
    });
  });

  it('never passes the plaintext webhook secret to the database', async () => {
    const { db, rpc } = fakeDb({}, { data: { config_id: 'cfg-1' } });

    await switchAccountToUazapi(db, input);

    expect(JSON.stringify(rpc.mock.calls)).not.toContain(
      'plain-webhook-secret'
    );
  });

  it('fails loudly when the transaction reports an error', async () => {
    const { db } = fakeDb({}, { error: { message: 'deadlock detected' } });

    await expect(switchAccountToUazapi(db, input)).rejects.toThrow(
      /switch_account_to_uazapi/
    );
  });

  it('fails when the transaction returns no configuration id', async () => {
    const { db } = fakeDb({}, { data: { cancelled_broadcasts: 0 } });

    await expect(switchAccountToUazapi(db, input)).rejects.toThrow(
      /switch_account_to_uazapi/
    );
  });

  it('defaults missing counters to zero rather than undefined', async () => {
    const { db } = fakeDb({}, { data: { config_id: 'cfg-1' } });

    await expect(switchAccountToUazapi(db, input)).resolves.toEqual({
      configId: 'cfg-1',
      cancelledBroadcasts: 0,
      deactivatedAutomations: 0,
      draftedFlows: 0,
      stoppedFlowRuns: 0,
    });
  });
});
