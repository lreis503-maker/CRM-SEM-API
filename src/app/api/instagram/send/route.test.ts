import { describe, expect, it, vi, beforeEach } from 'vitest';

const requireRoleMock = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return { ...actual, requireRole: (...args: unknown[]) => requireRoleMock(...args) };
});

const sendInstagramMessageMock = vi.fn();
vi.mock('@/lib/instagram/send-message', async () => {
  const actual = await vi.importActual<typeof import('@/lib/instagram/send-message')>(
    '@/lib/instagram/send-message',
  );
  return { ...actual, sendInstagramMessage: (...args: unknown[]) => sendInstagramMessageMock(...args) };
});

import { POST } from './route';
import { InstagramSendError } from '@/lib/instagram/send-message';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

beforeEach(() => {
  __resetRateLimitForTests();
  requireRoleMock.mockResolvedValue({ supabase: {}, accountId: 'acc-1', userId: 'user-1' });
});

describe('POST /api/instagram/send', () => {
  it('rejects a request missing required fields', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/send', { method: 'POST', body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns the sent message id on success', async () => {
    sendInstagramMessageMock.mockResolvedValue({ messageId: 'msg-1', igMessageId: 'ig-mid-1' });
    const res = await POST(
      new Request('http://localhost/api/instagram/send', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: 'conv-1', content_type: 'text', content_text: 'Hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true, message_id: 'msg-1', ig_message_id: 'ig-mid-1' });
  });

  it('maps InstagramSendError to its status and message', async () => {
    sendInstagramMessageMock.mockRejectedValue(new InstagramSendError('janela fechada', 409));
    const res = await POST(
      new Request('http://localhost/api/instagram/send', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: 'conv-1', content_type: 'text', content_text: 'Hi' }),
      }),
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('janela fechada');
  });
});
