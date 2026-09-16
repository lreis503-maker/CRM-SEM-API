/**
 * Moving an account from Meta to UAZAPI stops the work UAZAPI cannot do.
 *
 * Nothing is deleted: broadcasts become `cancelled` with a reason, the
 * automations and flows that rely on Meta-only steps are deactivated, and
 * their in-flight runs end. History stays readable so the user can switch
 * back and pick up where they left off.
 *
 * The write side is one `switch_account_to_uazapi` RPC (migration 044) so
 * a half-applied switch cannot leave an account with a UAZAPI row and a
 * queue of scheduled Meta template sends.
 */

export interface ProviderSwitchCounts {
  cancelledBroadcasts: number;
  deactivatedAutomations: number;
  draftedFlows: number;
  stoppedFlowRuns: number;
}

export interface ProviderSwitchResult extends ProviderSwitchCounts {
  configId: string;
}

export interface UazapiSwitchInput {
  accountId: string;
  userId: string;
  instanceId: string;
  instanceName: string;
  /** Already-encrypted instance token. The RPC never sees plaintext. */
  encryptedInstanceToken: string;
  /** SHA-256 of the route secret. The secret itself never leaves memory. */
  webhookSecretHash: string;
  connectionAttemptId: string;
}

/** Automation step type that only the Meta Cloud API can execute. */
const META_ONLY_STEP = 'send_template';

/** Flow node types that need Meta interactive messages. */
const META_ONLY_NODE_TYPES = ['send_buttons', 'send_list'];

/** Broadcast states that would still send after a provider switch. */
const PENDING_BROADCAST_STATUSES = ['scheduled', 'sending'];

type Row = Record<string, unknown>;

interface QueryResult {
  data: Row[] | null;
  error: unknown;
}

interface SwitchDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(
    name: string,
    params: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

async function rows(query: PromiseLike<QueryResult>): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

function distinct(values: Row[], column: string): string[] {
  const seen = new Set<string>();
  for (const row of values) {
    const value = row[column];
    if (typeof value === 'string') seen.add(value);
  }
  return [...seen];
}

/**
 * Reports what a switch to UAZAPI would stop, without changing anything.
 * Settings shows these numbers in the destructive-switch confirmation so
 * the user knows what they are about to interrupt.
 */
export async function prepareProviderSwitch(
  db: SwitchDatabase,
  accountId: string
): Promise<ProviderSwitchCounts> {
  const pendingBroadcasts = await rows(
    db
      .from('broadcasts')
      .select('id')
      .eq('account_id', accountId)
      .in('status', PENDING_BROADCAST_STATUSES)
  );

  const activeAutomationIds = distinct(
    await rows(
      db
        .from('automations')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_active', true)
    ),
    'id'
  );

  const incompatibleAutomations =
    activeAutomationIds.length === 0
      ? []
      : distinct(
          await rows(
            db
              .from('automation_steps')
              .select('automation_id')
              .eq('step_type', META_ONLY_STEP)
              .in('automation_id', activeAutomationIds)
          ),
          'automation_id'
        );

  const activeFlowIds = distinct(
    await rows(
      db
        .from('flows')
        .select('id')
        .eq('account_id', accountId)
        .eq('status', 'active')
    ),
    'id'
  );

  const incompatibleFlowIds =
    activeFlowIds.length === 0
      ? []
      : distinct(
          await rows(
            db
              .from('flow_nodes')
              .select('flow_id')
              .in('node_type', META_ONLY_NODE_TYPES)
              .in('flow_id', activeFlowIds)
          ),
          'flow_id'
        );

  const stoppedRuns =
    incompatibleFlowIds.length === 0
      ? []
      : await rows(
          db
            .from('flow_runs')
            .select('id')
            .eq('account_id', accountId)
            .eq('status', 'active')
            .in('flow_id', incompatibleFlowIds)
        );

  return {
    cancelledBroadcasts: pendingBroadcasts.length,
    deactivatedAutomations: incompatibleAutomations.length,
    draftedFlows: incompatibleFlowIds.length,
    stoppedFlowRuns: stoppedRuns.length,
  };
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/**
 * Replaces the account's single configuration row with a UAZAPI one and
 * stops incompatible work in the same transaction.
 */
export async function switchAccountToUazapi(
  db: SwitchDatabase,
  input: UazapiSwitchInput
): Promise<ProviderSwitchResult> {
  const { data, error } = await db.rpc('switch_account_to_uazapi', {
    p_account_id: input.accountId,
    p_user_id: input.userId,
    p_instance_id: input.instanceId,
    p_instance_name: input.instanceName,
    p_encrypted_instance_token: input.encryptedInstanceToken,
    p_webhook_secret_hash: input.webhookSecretHash,
    p_connection_attempt_id: input.connectionAttemptId,
  });

  if (error) {
    // The upstream message may name constraints but never credentials —
    // the RPC only ever received a hash and a ciphertext.
    throw new Error(
      `switch_account_to_uazapi failed: ${
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : 'unknown database error'
      }`
    );
  }

  const result =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)
      : {};
  const configId = result.config_id;

  if (typeof configId !== 'string' || configId.length === 0) {
    throw new Error(
      'switch_account_to_uazapi returned no configuration id; the switch was not applied'
    );
  }

  return {
    configId,
    cancelledBroadcasts: asCount(result.cancelled_broadcasts),
    deactivatedAutomations: asCount(result.deactivated_automations),
    draftedFlows: asCount(result.drafted_flows),
    stoppedFlowRuns: asCount(result.stopped_flow_runs),
  };
}
