import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { fetchInstagramProfile, markInstagramSeen } from '@/lib/instagram/graph-api';
import { mirrorInstagramMedia } from '@/lib/instagram/mirror-media';

export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

interface IgAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'share' | 'story_mention' | 'ig_reel' | 'reel';
  payload?: { url?: string };
}

interface IgMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: IgAttachment[];
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    reply_to?: { mid?: string; story?: unknown };
  };
}

interface IgWebhookEntry {
  id: string;
  time: number;
  messaging?: IgMessagingEvent[];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const challenge = searchParams.get('hub.challenge');
  const verifyToken = searchParams.get('hub.verify_token');

  if (mode !== 'subscribe' || !challenge || !verifyToken) {
    return NextResponse.json({ error: 'Parâmetros de verificação ausentes' }, { status: 400 });
  }

  const { data: configs, error } = await supabaseAdmin()
    .from('instagram_config')
    .select('id, verify_token');

  if (error || !configs) {
    return NextResponse.json({ error: 'Falha na verificação' }, { status: 403 });
  }

  const matched = configs.some((c: { verify_token: string }) => {
    try {
      return decrypt(c.verify_token) === verifyToken;
    } catch {
      return false;
    }
  });

  if (!matched) {
    return NextResponse.json({ error: 'Verify token mismatch' }, { status: 403 });
  }

  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[instagram webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 });
  }

  let body: { object?: string; entry?: IgWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  after(async () => {
    try {
      await processWebhook(body);
    } catch (err) {
      console.error('[instagram webhook] processing error:', err);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhook(body: { object?: string; entry?: IgWebhookEntry[] }) {
  if (body.object !== 'instagram' || !body.entry) return;

  for (const entry of body.entry) {
    if (!entry.messaging) continue;
    for (const event of entry.messaging) {
      await processMessagingEvent(entry.id, event);
    }
  }
}

async function processMessagingEvent(igUserId: string, event: IgMessagingEvent) {
  // Echoes are our own outbound sends mirrored back — already persisted
  // by the send route. Deleted / unsupported events carry no content
  // worth showing; skip both so the inbox never renders empty bubbles.
  if (!event.message || event.message.is_echo || event.message.is_deleted) return;

  const { data: config, error: configError } = await supabaseAdmin()
    .from('instagram_config')
    .select('account_id, page_access_token')
    .eq('ig_user_id', igUserId)
    .maybeSingle();

  if (configError || !config) {
    console.error('[instagram webhook] no config found for ig_user_id:', igUserId);
    return;
  }

  const pageAccessToken = decrypt(config.page_access_token);
  const igsid = event.sender.id;

  const contact = await findOrCreateContact(config.account_id, igsid, pageAccessToken);
  if (!contact) return;

  const conversation = await findOrCreateConversation(config.account_id, contact.id);
  if (!conversation) return;

  const { contentType, contentText, mediaUrl } = await parseMessageContent(
    event.message,
    config.account_id,
  );

  let replyToInternalId: string | null = null;
  if (event.message.reply_to?.mid) {
    const { data: parent } = await supabaseAdmin()
      .from('instagram_messages')
      .select('id')
      .eq('ig_message_id', event.message.reply_to.mid)
      .eq('conversation_id', conversation.id)
      .maybeSingle();
    replyToInternalId = parent?.id ?? null;
  }

  const { data: insertedRows, error: insertError } = await supabaseAdmin()
    .from('instagram_messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        ig_message_id: event.message.mid,
        status: 'delivered',
        reply_to_message_id: replyToInternalId,
        created_at: new Date(event.timestamp).toISOString(),
      },
      { onConflict: 'conversation_id,ig_message_id', ignoreDuplicates: true },
    )
    .select('id');

  if (insertError) {
    console.error('[instagram webhook] insert failed:', insertError);
    return;
  }
  if (!insertedRows || insertedRows.length === 0) {
    // Replayed delivery — Meta retries on a slow ack. Idempotent no-op.
    return;
  }

  const nowIso = new Date().toISOString();
  await supabaseAdmin()
    .from('instagram_conversations')
    .update({
      last_message_text: contentText ?? `[${contentType}]`,
      last_message_at: nowIso,
      last_customer_message_at: nowIso,
      unread_count: (conversation.unread_count ?? 0) + 1,
    })
    .eq('id', conversation.id);

  // Best-effort read receipt. Never let this fail the webhook.
  try {
    await markInstagramSeen({ igsid, pageAccessToken });
  } catch (err) {
    console.warn('[instagram webhook] mark_seen failed:', err instanceof Error ? err.message : err);
  }
}

async function parseMessageContent(
  message: NonNullable<IgMessagingEvent['message']>,
  accountId: string,
): Promise<{ contentType: string; contentText: string | null; mediaUrl: string | null }> {
  if (message.is_unsupported) {
    return { contentType: 'unsupported', contentText: '[Mensagem não compatível]', mediaUrl: null };
  }

  const attachment = message.attachments?.[0];
  if (attachment) {
    const typeMap: Record<string, string> = {
      image: 'image',
      video: 'video',
      audio: 'audio',
      file: 'file',
      share: 'share',
      story_mention: 'story_mention',
      ig_reel: 'share',
      reel: 'share',
    };
    const contentType = typeMap[attachment.type] ?? 'unsupported';
    let mediaUrl: string | null = attachment.payload?.url ?? null;
    if (mediaUrl) {
      const mirrored = await mirrorInstagramMedia({
        storage: supabaseAdmin().storage,
        accountId,
        sourceUrl: mediaUrl,
        stableId: `${message.mid}-${attachment.type}`,
        fallbackExtension: attachment.type === 'video' ? 'mp4' : attachment.type === 'audio' ? 'mp3' : 'jpg',
      });
      if (mirrored) mediaUrl = mirrored;
    }
    return { contentType, contentText: message.text ?? null, mediaUrl };
  }

  return { contentType: 'text', contentText: message.text ?? null, mediaUrl: null };
}

async function findOrCreateContact(accountId: string, igsid: string, pageAccessToken: string) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('instagram_contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('igsid', igsid)
    .maybeSingle();

  if (findError) {
    console.error('[instagram webhook] contact lookup failed:', findError);
    return null;
  }
  if (existing) return existing;

  // First time we see this person — fetch their public profile.
  // Best-effort: Meta can refuse this (no consent yet) without
  // blocking the message itself from being stored.
  let name: string | null = null;
  let username: string | null = null;
  let profilePicUrl: string | null = null;
  try {
    const profile = await fetchInstagramProfile({ igsid, pageAccessToken });
    name = profile.name ?? null;
    username = profile.username ?? null;
    if (profile.profile_pic) {
      profilePicUrl = await mirrorInstagramMedia({
        storage: supabaseAdmin().storage,
        accountId,
        sourceUrl: profile.profile_pic,
        stableId: `profile-${igsid}`,
        fallbackExtension: 'jpg',
      });
    }
  } catch (err) {
    console.warn('[instagram webhook] profile fetch failed:', err instanceof Error ? err.message : err);
  }

  const { data: created, error: createError } = await supabaseAdmin()
    .from('instagram_contacts')
    .insert({ account_id: accountId, igsid, name, username, profile_pic_url: profilePicUrl })
    .select()
    .single();

  if (createError) {
    // Lost a race with a concurrent delivery for the same igsid.
    const { data: raced } = await supabaseAdmin()
      .from('instagram_contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('igsid', igsid)
      .maybeSingle();
    if (raced) return raced;
    console.error('[instagram webhook] contact creation failed:', createError);
    return null;
  }

  return created;
}

async function findOrCreateConversation(accountId: string, contactId: string) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('instagram_conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (findError) {
    console.error('[instagram webhook] conversation lookup failed:', findError);
    return null;
  }
  if (existing) return existing;

  const { data: created, error: createError } = await supabaseAdmin()
    .from('instagram_conversations')
    .insert({ account_id: accountId, contact_id: contactId })
    .select()
    .single();

  if (createError) {
    const { data: raced } = await supabaseAdmin()
      .from('instagram_conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle();
    if (raced) return raced;
    console.error('[instagram webhook] conversation creation failed:', createError);
    return null;
  }

  return created;
}
