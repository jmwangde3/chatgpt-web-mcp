export const DEFAULT_PROGRESS_STALL_MS = 120_000;
export const POLL_BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 10_000];

/**
 * Attach advisory, non-destructive progress metadata to a durable task.
 * Partial response text is never persisted by this helper.
 */
export function updateTaskProgress(task, observed = {}, now = Date.now(), stallAfterMs = DEFAULT_PROGRESS_STALL_MS, hashFn) {
  const text = typeof observed.text === 'string' ? observed.text : '';
  const responseChars = Array.from(text).length;
  const hash = hashFn ? hashFn(text) : `${text.length}:${text.slice(0, 32)}:${text.slice(-32)}`;
  const changed = text.length > 0 && hash !== task.progressHash;
  const previousAt = Number.isFinite(task.progress?.last_progress_at)
    ? task.progress.last_progress_at
    : task.submitted_at ?? task.created_at ?? now;
  const lastProgressAt = changed ? now : previousAt;
  const noProgressMs = Math.max(0, now - lastProgressAt);

  let phase = 'waiting';
  if (observed.busy) {
    phase = noProgressMs >= stallAfterMs ? 'stalled' : responseChars > 0 ? 'streaming' : 'thinking';
  } else if (task.state === 'preparing' || task.state === 'submitting') {
    phase = 'waiting_for_ack';
  }

  task.progressHash = hash;
  task.progress = { phase, response_chars: responseChars, last_progress_at: lastProgressAt, no_progress_ms: noProgressMs };
  return task.progress;
}

/** Back off 2s -> 4s -> 8s -> 10s; visible progress resets to 2s. */
export function nextPollDelayMs(stepIndex, hadProgress, remainingBudgetMs) {
  const nextStep = hadProgress ? 0 : Math.min(stepIndex + 1, POLL_BACKOFF_STEPS_MS.length - 1);
  const base = POLL_BACKOFF_STEPS_MS[nextStep];
  return { nextStep, delayMs: Math.max(1, Math.min(base, remainingBudgetMs)) };
}
