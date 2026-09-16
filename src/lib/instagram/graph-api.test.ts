import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchInstagramProfile,
  InstagramApiError,
  markInstagramSeen,
  sendInstagramAttachmentMessage,
  sendInstagramTextMessage,
} from './graph-api';

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendInstagramTextMessage', () => {
  it('posts to /me/messages and returns the message id', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1', message_id: 'mid-1' });
    const result = await sendInstagramTextMessage({
      igsid: 'igsid-1',
      pageAccessToken: 'token',
      text: 'Hello',
    });
    expect(result).toEqual({ recipientId: 'igsid-1', messageId: 'mid-1' });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/me/messages');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      recipient: { id: 'igsid-1' },
      message: { text: 'Hello' },
    });
  });

  it('includes reply_to when replyToMid is set', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1', message_id: 'mid-2' });
    await sendInstagramTextMessage({
      igsid: 'igsid-1',
      pageAccessToken: 'token',
      text: 'Hi',
      replyToMid: 'mid-1',
    });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).reply_to).toEqual({ mid: 'mid-1' });
  });

  it('throws InstagramApiError carrying the messaging-window code on a closed-window response', async () => {
    mockFetchOnce(400, { error: { message: 'Messaging window closed', code: 1545041 } });
    await expect(
      sendInstagramTextMessage({ igsid: 'igsid-1', pageAccessToken: 'token', text: 'Hi' }),
    ).rejects.toMatchObject({ code: 1545041 } satisfies Partial<InstagramApiError>);
  });
});

describe('sendInstagramAttachmentMessage', () => {
  it('posts an attachment payload with the given type and url', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1', message_id: 'mid-3' });
    await sendInstagramAttachmentMessage({
      igsid: 'igsid-1',
      pageAccessToken: 'token',
      attachmentType: 'image',
      mediaUrl: 'https://example.com/a.png',
    });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      recipient: { id: 'igsid-1' },
      message: { attachment: { type: 'image', payload: { url: 'https://example.com/a.png' } } },
    });
  });
});

describe('fetchInstagramProfile', () => {
  it('returns the profile fields', async () => {
    mockFetchOnce(200, { name: 'Jane', username: 'jane.doe', profile_pic: 'https://x/y.jpg' });
    const profile = await fetchInstagramProfile({ igsid: 'igsid-1', pageAccessToken: 'token' });
    expect(profile).toEqual({ name: 'Jane', username: 'jane.doe', profile_pic: 'https://x/y.jpg' });
  });
});

describe('markInstagramSeen', () => {
  it('posts a mark_seen sender action', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1' });
    await markInstagramSeen({ igsid: 'igsid-1', pageAccessToken: 'token' });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      recipient: { id: 'igsid-1' },
      sender_action: 'mark_seen',
    });
  });
});
