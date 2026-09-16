import { describe, expect, it, vi } from 'vitest';
import {
  InstagramSendError,
  sendInstagramMessage,
  validateSendInstagramMessageParams,
} from './send-message';
import * as graphApi from './graph-api';
import { encrypt } from '@/lib/whatsapp/encryption';

vi.mock('./graph-api', async () => {
  const actual = await vi.importActual<typeof graphApi>('./graph-api');
  return {
    ...actual,
    sendInstagramTextMessage: vi.fn(),
    sendInstagramAttachmentMessage: vi.fn(),
  };
});

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

function thenable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.insert = chain;
  builder.update = chain;
  builder.maybeSingle = async () => result;
  builder.single = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => resolve(result);
  return builder;
}

describe('validateSendInstagramMessageParams', () => {
  it('requires non-empty text for a text message', () => {
    expect(() => validateSendInstagramMessageParams({ contentType: 'text', contentText: '' })).toThrow(
      InstagramSendError,
    );
  });

  it('requires a media url for an attachment message', () => {
    expect(() => validateSendInstagramMessageParams({ contentType: 'image' })).toThrow(InstagramSendError);
  });

  it('accepts a valid text message', () => {
    expect(() =>
      validateSendInstagramMessageParams({ contentType: 'text', contentText: 'Hi' }),
    ).not.toThrow();
  });
});

describe('sendInstagramMessage', () => {
  it('rejects when the 24h messaging window is closed', async () => {
    const supabase = {
      from: (table: string) => {
        if (table === 'instagram_conversations') {
          return thenable({
            data: {
              id: 'conv-1',
              account_id: 'acc-1',
              contact_id: 'contact-1',
              last_customer_message_at: '2000-01-01T00:00:00.000Z',
              instagram_contacts: { igsid: 'igsid-1' },
            },
            error: null,
          });
        }
        throw new Error(`unexpected table ${table}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(
      sendInstagramMessage(supabase, 'acc-1', {
        conversationId: 'conv-1',
        contentType: 'text',
        contentText: 'Hi',
      }),
    ).rejects.toThrow('janela de 24h');
  });

  it('sends a text message and persists it when the window is open', async () => {
    const now = new Date().toISOString();
    const inserted = { id: 'msg-1' };
    const supabase = {
      from: (table: string) => {
        if (table === 'instagram_conversations') {
          return thenable({
            data: {
              id: 'conv-1',
              account_id: 'acc-1',
              contact_id: 'contact-1',
              last_customer_message_at: now,
              instagram_contacts: { igsid: 'igsid-1' },
            },
            error: null,
          });
        }
        if (table === 'instagram_config') {
          return thenable({ data: { page_access_token: encrypt('page-token') }, error: null });
        }
        if (table === 'instagram_messages') {
          return thenable({ data: inserted, error: null });
        }
        throw new Error(`unexpected table ${table}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    vi.mocked(graphApi.sendInstagramTextMessage).mockResolvedValue({
      recipientId: 'igsid-1',
      messageId: 'ig-mid-1',
    });

    const result = await sendInstagramMessage(supabase, 'acc-1', {
      conversationId: 'conv-1',
      contentType: 'text',
      contentText: 'Hello there',
    });

    expect(result).toEqual({ messageId: 'msg-1', igMessageId: 'ig-mid-1' });
    expect(graphApi.sendInstagramTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ igsid: 'igsid-1', text: 'Hello there' }),
    );
  });
});
