import { beforeEach, describe, expect, it, vi } from 'vitest';

// The avatar fix touches only contact resolution, so everything else
// resolveInboundParticipants can reach — dedup, the identity table, the
// conversation.created webhook — is faked out rather than re-implemented
// here. That keeps this file testing exactly the new behaviour: whether a
// contact ends up with an `avatar_url`.
vi.mock('../../contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null),
  isUniqueViolation: () => false,
}));
vi.mock('./contact-identities', () => ({
  findContactIdByExternalIdentity: vi.fn(async () => null),
  attachExternalIdentity: vi.fn(async (_db: unknown, _identity: unknown, contactId: string) => contactId),
}));
vi.mock('../../webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

import { resolveInboundParticipants } from './process-inbound-message';
import type { InboundAvatarResolver, NormalizedSender } from './types';

interface FakeState {
  existingContact: Record<string, unknown> | null;
  contactInserts: Record<string, unknown>[];
  contactUpdates: Record<string, unknown>[];
}

function fakeDb(state: FakeState) {
  function contactsBuilder() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: state.existingContact, error: null }),
      insert: (row: Record<string, unknown>) => {
        state.contactInserts.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: { id: 'new-contact-id', avatar_url: null, ...row },
              error: null,
            }),
          }),
        };
      },
      update: (patch: Record<string, unknown>) => {
        state.contactUpdates.push(patch);
        return {
          eq: () => ({
            select: () => ({
              maybeSingle: async () => ({
                data: { ...state.existingContact, ...patch },
                error: null,
              }),
            }),
          }),
        };
      },
    };
    return builder;
  }

  function conversationsBuilder() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: async () => ({ data: [{ id: 'conv-1' }], error: null }),
    };
    return builder;
  }

  return {
    from(table: string) {
      if (table === 'contacts') return contactsBuilder();
      if (table === 'conversations') return conversationsBuilder();
      throw new Error(`unexpected table in test fake: ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const SENDER: NormalizedSender = {
  phone: '5511999999999',
  externalId: '5511999999999@s.whatsapp.net',
  externalIdKind: 'jid',
  parentExternalId: null,
  profileName: 'Ada',
  displayName: 'Ada',
  username: null,
};

// bsuid, not jid: only a bsuid makes findOrCreateContact look the sender up
// directly by `contacts.wa_user_id` (findContactByWaUserId), which is the
// one existing-contact lookup path this file's fake db actually serves —
// the phone/identity fallbacks live in mocked-out modules above.
const SENDER_WITH_MATCHABLE_ID: NormalizedSender = {
  ...SENDER,
  externalIdKind: 'bsuid',
};

describe('resolveInboundParticipants — contact avatar (UAZAPI /chat/details bug)', () => {
  let state: FakeState;

  beforeEach(() => {
    state = { existingContact: null, contactInserts: [], contactUpdates: [] };
  });

  it('stores the resolved avatar on a brand-new contact', async () => {
    const resolveAvatar: InboundAvatarResolver = vi.fn(async () => 'https://cdn.test/ada.jpg');

    await resolveInboundParticipants({
      db: fakeDb(state),
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      provider: 'uazapi',
      sender: SENDER,
      resolveAvatar,
    });

    expect(resolveAvatar).toHaveBeenCalledWith('5511999999999');
    expect(state.contactInserts).toHaveLength(1);
    expect(state.contactInserts[0]).toMatchObject({
      avatar_url: 'https://cdn.test/ada.jpg',
    });
  });

  it('creates the contact with no avatar when no resolver is given (Meta path, unchanged)', async () => {
    await resolveInboundParticipants({
      db: fakeDb(state),
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      provider: 'uazapi',
      sender: SENDER,
    });

    expect(state.contactInserts).toHaveLength(1);
    expect(state.contactInserts[0]).toMatchObject({ avatar_url: null });
  });

  it('creates the contact with no avatar when the resolver finds none', async () => {
    const resolveAvatar: InboundAvatarResolver = vi.fn(async () => null);

    await resolveInboundParticipants({
      db: fakeDb(state),
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      provider: 'uazapi',
      sender: SENDER,
      resolveAvatar,
    });

    expect(state.contactInserts[0]).toMatchObject({ avatar_url: null });
  });

  it('backfills an existing contact that has no photo yet', async () => {
    state.existingContact = {
      id: 'existing-1',
      account_id: 'acc-1',
      avatar_url: null,
      name: 'Ada',
      wa_user_id: null,
      wa_parent_user_id: null,
      wa_username: null,
      phone: '5511999999999',
    };
    const resolveAvatar: InboundAvatarResolver = vi.fn(async () => 'https://cdn.test/ada.jpg');

    await resolveInboundParticipants({
      db: fakeDb(state),
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      provider: 'uazapi',
      sender: SENDER_WITH_MATCHABLE_ID,
      resolveAvatar,
    });

    expect(state.contactUpdates).toHaveLength(1);
    expect(state.contactUpdates[0]).toMatchObject({
      avatar_url: 'https://cdn.test/ada.jpg',
    });
  });

  it('does not call the resolver again for a contact that already has a photo', async () => {
    state.existingContact = {
      id: 'existing-1',
      account_id: 'acc-1',
      avatar_url: 'https://cdn.test/already-has-one.jpg',
      name: 'Ada',
      wa_user_id: null,
      wa_parent_user_id: null,
      wa_username: null,
      phone: '5511999999999',
    };
    const resolveAvatar: InboundAvatarResolver = vi.fn(async () => 'https://cdn.test/new.jpg');

    await resolveInboundParticipants({
      db: fakeDb(state),
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      provider: 'uazapi',
      sender: SENDER_WITH_MATCHABLE_ID,
      resolveAvatar,
    });

    expect(resolveAvatar).not.toHaveBeenCalled();
    // An identity backfill can still run (unrelated to the photo); the
    // one thing that must never happen is overwriting the existing photo.
    for (const patch of state.contactUpdates) {
      expect(patch).not.toHaveProperty('avatar_url');
    }
  });
});
