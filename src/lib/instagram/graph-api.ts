const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = 'InstagramApiError';
  }
}

async function graphFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = `${GRAPH_API_BASE}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: number; error_subcode?: number } }).error;
    throw new InstagramApiError(
      err?.message ?? `Instagram Graph API request failed with status ${res.status}`,
      res.status,
      err?.code,
      err?.error_subcode,
    );
  }
  return data;
}

export interface InstagramProfile {
  name?: string;
  username?: string;
  profile_pic?: string;
}

/** Fetch the customer's public profile by IGSID. Requires prior consent
 *  (they must have messaged the business first) — Meta returns a 400
 *  otherwise, which callers should treat as "no profile available". */
export async function fetchInstagramProfile(args: {
  igsid: string;
  pageAccessToken: string;
}): Promise<InstagramProfile> {
  const data = await graphFetch(
    `/${args.igsid}?fields=name,username,profile_pic`,
    args.pageAccessToken,
  );
  return data as InstagramProfile;
}

export type InstagramOutboundAttachmentType = 'image' | 'video' | 'audio' | 'file';

export interface SendTextMessageArgs {
  igsid: string;
  pageAccessToken: string;
  text: string;
  replyToMid?: string;
}

export interface SendAttachmentMessageArgs {
  igsid: string;
  pageAccessToken: string;
  attachmentType: InstagramOutboundAttachmentType;
  mediaUrl: string;
  replyToMid?: string;
}

export interface SendMessageResult {
  recipientId: string;
  messageId: string;
}

function parseSendResult(data: unknown): SendMessageResult {
  const d = data as { recipient_id?: string; message_id?: string };
  return { recipientId: d.recipient_id ?? '', messageId: d.message_id ?? '' };
}

export async function sendInstagramTextMessage(
  args: SendTextMessageArgs,
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    recipient: { id: args.igsid },
    message: { text: args.text },
  };
  if (args.replyToMid) body.reply_to = { mid: args.replyToMid };
  const data = await graphFetch('/me/messages', args.pageAccessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseSendResult(data);
}

export async function sendInstagramAttachmentMessage(
  args: SendAttachmentMessageArgs,
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    recipient: { id: args.igsid },
    message: {
      attachment: { type: args.attachmentType, payload: { url: args.mediaUrl } },
    },
  };
  if (args.replyToMid) body.reply_to = { mid: args.replyToMid };
  const data = await graphFetch('/me/messages', args.pageAccessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseSendResult(data);
}

/** Marks the customer's most recent message as read. Best-effort UX —
 *  callers should not fail the surrounding operation if this throws. */
export async function markInstagramSeen(args: {
  igsid: string;
  pageAccessToken: string;
}): Promise<void> {
  await graphFetch('/me/messages', args.pageAccessToken, {
    method: 'POST',
    body: JSON.stringify({ recipient: { id: args.igsid }, sender_action: 'mark_seen' }),
  });
}
