import { describe, expect, it } from 'vitest';

import {
  deriveHistoryImportView,
  type HistoryImportProgress,
  type HistoryImportViewInput,
} from './history-import-state';

function run(
  overrides: Partial<HistoryImportProgress> = {}
): HistoryImportProgress {
  return {
    status: 'completed',
    chatsSeen: 12,
    messagesImported: 340,
    errorCode: null,
    startedAt: '2026-09-15T00:00:00.000Z',
    finishedAt: '2026-09-15T00:04:00.000Z',
    ...overrides,
  };
}

function view(overrides: Partial<HistoryImportViewInput> = {}) {
  return deriveHistoryImportView({
    run: null,
    working: false,
    connected: true,
    canEdit: true,
    ...overrides,
  });
}

describe('deriveHistoryImportView', () => {
  it('offers the first import when nothing has ever run', () => {
    expect(view()).toMatchObject({
      action: 'start',
      showProgress: false,
      tone: 'idle',
    });
  });

  it('offers to pick up a run that stopped half-way', () => {
    // The usual cause is a closed tab: the cursor is saved server-side,
    // so this continues rather than starting over.
    expect(
      view({ run: run({ status: 'running', finishedAt: null }) })
    ).toMatchObject({
      action: 'resume',
      showProgress: true,
    });
  });

  it('offers to retry after a failed run, from where it stopped', () => {
    expect(
      view({
        run: run({ status: 'failed', errorCode: 'provider_unavailable' }),
      })
    ).toMatchObject({ action: 'resume', failed: true, tone: 'error' });
  });

  it('offers a second pass once it finished', () => {
    expect(view({ run: run() })).toMatchObject({
      action: 'again',
      tone: 'success',
      chatsSeen: 12,
      messagesImported: 340,
    });
  });

  it('presses nothing while batches are in flight', () => {
    expect(
      view({ run: run({ status: 'running' }), working: true })
    ).toMatchObject({
      action: 'none',
      busy: true,
      tone: 'pending',
    });
  });

  it('offers nothing to a member who cannot change the connection', () => {
    expect(view({ canEdit: false })).toMatchObject({ action: 'none' });
  });

  it('offers nothing while the number is unpaired', () => {
    // There is no instance to read a history from yet.
    expect(view({ connected: false })).toMatchObject({ action: 'none' });
  });

  it('keeps showing the counters of a finished run', () => {
    expect(
      view({ run: run({ chatsSeen: 3, messagesImported: 9 }) })
    ).toMatchObject({
      showProgress: true,
      chatsSeen: 3,
      messagesImported: 9,
    });
  });
});
