/**
 * What the history import card should show.
 *
 * Kept as a pure function, like the connection panel's view state, so
 * every branch — never run, running, stopped half-way, failed — is
 * testable without rendering, and so the card itself decides nothing.
 */

export type HistoryImportStatus = 'running' | 'completed' | 'failed';

export interface HistoryImportProgress {
  status: HistoryImportStatus;
  chatsSeen: number;
  messagesImported: number;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface HistoryImportViewInput {
  /** The latest run, or null when the account has never imported. */
  run: HistoryImportProgress | null;
  /** True while this browser is driving the batches. */
  working: boolean;
  /** False when the number is not paired, so there is nothing to read. */
  connected: boolean;
  canEdit: boolean;
}

export type HistoryImportAction =
  /** Nothing has been imported yet. */
  | 'start'
  /**
   * A run stopped before it finished — a closed tab, a failed batch.
   * Pressing this picks the walk up where it left off.
   */
  | 'resume'
  /** It finished; a second pass only picks up what has happened since. */
  | 'again'
  /** Busy, or not allowed. */
  | 'none';

export interface HistoryImportView {
  action: HistoryImportAction;
  /** True while batches are being sent, so the card shows a spinner. */
  busy: boolean;
  /** Show the counters at all. */
  showProgress: boolean;
  chatsSeen: number;
  messagesImported: number;
  /** True when the last run ended badly and the reason is worth showing. */
  failed: boolean;
  tone: 'idle' | 'pending' | 'success' | 'error';
}

export function deriveHistoryImportView(
  input: HistoryImportViewInput
): HistoryImportView {
  const { run, working, connected, canEdit } = input;

  const chatsSeen = run?.chatsSeen ?? 0;
  const messagesImported = run?.messagesImported ?? 0;
  const showProgress = run !== null;
  const failed = run?.status === 'failed';

  // An unfinished run is the normal state after a closed tab, not an
  // error: the cursor is saved and the walk resumes from it.
  const unfinished = run?.status === 'running';

  const action: HistoryImportAction = !canEdit
    ? 'none'
    : !connected
      ? 'none'
      : working
        ? 'none'
        : run === null
          ? 'start'
          : unfinished || failed
            ? 'resume'
            : 'again';

  return {
    action,
    busy: working,
    showProgress,
    chatsSeen,
    messagesImported,
    failed,
    tone: working
      ? 'pending'
      : failed
        ? 'error'
        : run?.status === 'completed'
          ? 'success'
          : 'idle',
  };
}
