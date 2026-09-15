import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/whatsapp/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { importUazapiHistoryBatch } from '@/lib/whatsapp/history/import-uazapi-history';
import { createUazapiMediaResolver } from '@/lib/whatsapp/inbound/uazapi-media';
import { processInboundMessage } from '@/lib/whatsapp/inbound/process-inbound-message';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound/types';
import { resolveUazapiInstallation } from '@/lib/whatsapp/providers/account-capabilities';
import { createUazapiInstanceClient } from '@/lib/whatsapp/providers/uazapi-client';

/**
 * Backfilling the WhatsApp history into the inbox.
 *
 * An account can hold years of conversation, far more than one request
 * can walk. So a run is a series of bounded batches: each POST does a
 * page of chats, records where it stopped, and says whether there is
 * more. Settings calls it again until `done`, and a stopped import simply
 * resumes from its cursor next time.
 *
 * Every message it stores is marked `imported`, which makes it inert: it
 * is shown in the thread but never marks it unread, never advances a
 * flow, never fires an automation, never wakes the AI and never reaches
 * an outbound webhook. A backfill that did any of that would send real
 * people a burst of messages about conversations that ended long ago.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;

interface ImportRun {
  id: string;
  status: string;
  chat_offset: number;
  message_offset: number;
  chats_seen: number;
  messages_imported: number;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const CONFIG_COLUMNS =
  'id, account_id, user_id, provider, status, uazapi_instance_id, mirror_inbound_media';

const RUN_COLUMNS =
  'id, status, chat_offset, message_offset, chats_seen, messages_imported, error_code, started_at, finished_at';

async function loadConfig(db: Database, accountId: string) {
  const { data, error } = await db
    .from('whatsapp_config')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data as {
    id: string;
    account_id: string;
    user_id: string;
    provider: string;
    status: string;
    mirror_inbound_media: boolean | null;
  } | null;
}

async function loadLatestRun(
  db: Database,
  accountId: string
): Promise<ImportRun | null> {
  const { data, error } = await db
    .from('whatsapp_history_imports')
    .select(RUN_COLUMNS)
    .eq('account_id', accountId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as ImportRun | null) ?? null;
}

async function loadInstanceToken(
  db: Database,
  configId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('whatsapp_config_secrets')
    .select('uazapi_instance_token')
    .eq('whatsapp_config_id', configId)
    .maybeSingle();
  if (error) throw error;

  const ciphertext = (data as { uazapi_instance_token?: string } | null)
    ?.uazapi_instance_token;
  return typeof ciphertext === 'string' && ciphertext.length > 0
    ? decrypt(ciphertext)
    : null;
}

/** Progress only. Never the cursor, the config id or anything secret. */
function publicRun(run: ImportRun | null) {
  if (run === null) return null;
  return {
    status: run.status,
    chatsSeen: run.chats_seen,
    messagesImported: run.messages_imported,
    errorCode: run.error_code,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };
}

/**
 * GET /api/whatsapp/uazapi/import-history
 *
 * The state of the latest run, polled by Settings. Progress is not a
 * credential, so any member may read it.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('viewer');
    const db = supabaseAdmin();

    return NextResponse.json({
      import: publicRun(await loadLatestRun(db, accountId)),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * POST /api/whatsapp/uazapi/import-history
 *
 * Runs one batch. Writes into every conversation in the account, so it
 * takes an admin.
 */
export async function POST() {
  try {
    const { accountId } = await requireRole('admin');

    const installation = resolveUazapiInstallation(process.env);
    if (!installation) {
      return NextResponse.json(
        { error: 'uazapi_not_available' },
        { status: 503 }
      );
    }

    const db = supabaseAdmin();
    const config = await loadConfig(db, accountId);

    if (!config || config.provider !== 'uazapi') {
      // The same 409 the rest of the provider matrix answers with, so the
      // browser has one shape to handle.
      return NextResponse.json(
        { error: 'provider_not_supported' },
        { status: 409 }
      );
    }

    if (config.status !== 'connected') {
      return NextResponse.json({ error: 'not_connected' }, { status: 409 });
    }

    const instanceToken = await loadInstanceToken(db, config.id);
    if (instanceToken === null) {
      return NextResponse.json({ error: 'not_connected' }, { status: 409 });
    }

    const previous = await loadLatestRun(db, accountId);
    // A run that is still open is resumed rather than replaced: its
    // cursor is the only record of how far the walk got.
    const run =
      previous?.status === 'running'
        ? previous
        : await startRun(db, accountId, config.id);
    if (run === null) {
      // Someone else started one between the read and the insert. Theirs
      // is doing the work; this call has nothing to add.
      return NextResponse.json(
        { error: 'import_already_running' },
        { status: 409 }
      );
    }

    const client = createUazapiInstanceClient({
      baseUrl: installation.baseUrl,
      instanceToken,
    });

    let batch;
    try {
      batch = await importUazapiHistoryBatch({
        client,
        chatOffset: run.chat_offset ?? 0,
        messageOffset: run.message_offset ?? 0,
        store: (event: NormalizedInboundMessage) =>
          processInboundMessage({
            db,
            event,
            accountId: config.account_id,
            configOwnerUserId: config.user_id,
            // The whole point of the flag: stored and shown, reacting to
            // nothing.
            imported: true,
            resolveMedia: createUazapiMediaResolver({
              client,
              storage:
                config.mirror_inbound_media !== false
                  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (db as any).storage
                  : null,
              accountId: config.account_id,
              occurredAt: event.occurredAt,
            }),
          }),
      });
    } catch (error) {
      // The run is closed as failed so the next click starts clean rather
      // than resuming a cursor whose batch never landed. The upstream
      // detail stays in the server log.
      console.error(
        '[uazapi-history] batch failed:',
        error instanceof Error ? error.name : 'unknown'
      );
      await db
        .from('whatsapp_history_imports')
        .update({
          status: 'failed',
          error_code: 'provider_unavailable',
          finished_at: new Date().toISOString(),
        })
        .eq('id', run.id);

      return NextResponse.json(
        { error: 'provider_unavailable' },
        { status: 502 }
      );
    }

    const chatsSeen = (run.chats_seen ?? 0) + batch.chatsSeen;
    const messagesImported =
      (run.messages_imported ?? 0) + batch.messagesImported;

    await db
      .from('whatsapp_history_imports')
      .update({
        chat_offset: batch.nextChatOffset,
        message_offset: batch.nextMessageOffset,
        chats_seen: chatsSeen,
        messages_imported: messagesImported,
        status: batch.done ? 'completed' : 'running',
        finished_at: batch.done ? new Date().toISOString() : null,
      })
      .eq('id', run.id);

    return NextResponse.json({
      done: batch.done,
      chatsSeen,
      messagesImported,
      failedChats: batch.failedChats,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

async function startRun(
  db: Database,
  accountId: string,
  configId: string
): Promise<ImportRun | null> {
  const { data, error } = await db
    .from('whatsapp_history_imports')
    .insert({
      account_id: accountId,
      config_id: configId,
      provider: 'uazapi',
      status: 'running',
    })
    .select(RUN_COLUMNS)
    .single();

  // 23505 is the partial unique index refusing a second running import
  // for the account — a race, not a bug.
  if (error) {
    if ((error as { code?: string }).code === '23505') return null;
    throw error;
  }
  return data as ImportRun;
}
