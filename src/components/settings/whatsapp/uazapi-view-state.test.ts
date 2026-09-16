import { describe, expect, it } from 'vitest';

import { deriveUazapiViewState } from './uazapi-view-state';

const QR = 'data:image/png;base64,iVBORw0KGgo=';

describe('deriveUazapiViewState', () => {
  it('shows a new QR action after expiry', () => {
    expect(
      deriveUazapiViewState(
        {
          status: 'connecting',
          qrCodeDataUrl: QR,
          qrExpiresAt: '2026-09-15T12:00:00Z',
        },
        new Date('2026-09-15T12:02:01Z')
      )
    ).toMatchObject({ showQr: false, primaryAction: 'refresh_qr' });
  });

  it('stops polling when connected', () => {
    expect(
      deriveUazapiViewState({ status: 'connected' }, new Date()).poll
    ).toBe(false);
  });

  it('shows the QR and keeps polling while the code is still valid', () => {
    const state = deriveUazapiViewState(
      {
        status: 'connecting',
        qrCodeDataUrl: QR,
        qrExpiresAt: '2026-09-15T12:02:00Z',
      },
      new Date('2026-09-15T12:01:30Z')
    );

    expect(state).toMatchObject({
      showQr: true,
      poll: true,
      qrExpired: false,
      primaryAction: 'none',
      canRemove: true,
      tone: 'pending',
    });
    expect(state.secondsLeft).toBe(30);
  });

  it('offers the first connection for an account with no instance', () => {
    expect(
      deriveUazapiViewState({ status: 'not_configured' }, new Date())
    ).toMatchObject({
      showQr: false,
      poll: false,
      primaryAction: 'start',
      canRemove: false,
    });
  });

  it('offers a reconnect for a hibernated session without polling', () => {
    expect(
      deriveUazapiViewState({ status: 'hibernated' }, new Date())
    ).toMatchObject({
      poll: false,
      primaryAction: 'reconnect',
      tone: 'warning',
      canRemove: true,
    });
  });

  it('offers a retry on the same instance after an error', () => {
    expect(
      deriveUazapiViewState(
        { status: 'error', error: 'upstream_unavailable' },
        new Date()
      )
    ).toMatchObject({ poll: false, primaryAction: 'retry', tone: 'error' });
  });

  it('offers a new QR for a disconnected instance', () => {
    expect(
      deriveUazapiViewState({ status: 'disconnected' }, new Date())
    ).toMatchObject({
      poll: false,
      primaryAction: 'refresh_qr',
      showQr: false,
    });
  });

  it('asks for a new QR instead of polling forever without a code', () => {
    expect(
      deriveUazapiViewState(
        { status: 'connecting', qrCodeDataUrl: null, qrExpiresAt: null },
        new Date()
      )
    ).toMatchObject({
      poll: false,
      showQr: false,
      primaryAction: 'refresh_qr',
    });
  });

  it('reports a connected session as successful and removable', () => {
    expect(
      deriveUazapiViewState({ status: 'connected' }, new Date())
    ).toMatchObject({
      tone: 'success',
      primaryAction: 'none',
      canRemove: true,
      showQr: false,
    });
  });

  it('never reports a negative countdown', () => {
    const state = deriveUazapiViewState(
      {
        status: 'connecting',
        qrCodeDataUrl: QR,
        qrExpiresAt: '2026-09-15T12:00:00Z',
      },
      new Date('2026-09-15T12:05:00Z')
    );

    expect(state.secondsLeft).toBe(0);
    expect(state.qrExpired).toBe(true);
  });

  it('treats an unreadable expiry as expired rather than trusting it', () => {
    expect(
      deriveUazapiViewState(
        { status: 'connecting', qrCodeDataUrl: QR, qrExpiresAt: 'not-a-date' },
        new Date()
      )
    ).toMatchObject({
      showQr: false,
      poll: false,
      primaryAction: 'refresh_qr',
    });
  });
});
