// Guidance only. Never turn a diagnostic suggestion into an automatic action.
export function recoveryFor(task) {
  if (['completed', 'cancelled', 'failed', 'abandoned'].includes(task.state)) {
    return { action: 'none', automatic_retry: false, message: 'Tracking finished. Reusing the request_id will return this record without sending.' };
  }
  const code = task.error?.code;
  if (code === 'SESSION_TAB_MISSING') return { action: 'inspect_session_tab', automatic_retry: false, message: 'The bound session tab is missing. Do not resend. Inspect the saved conversation manually; use another session only for independent new work.' };
  if (code === 'CONVERSATION_CHANGED') return { action: 'return_to_conversation', automatic_retry: false, message: 'Manually open the saved conversation in the dedicated browser, then call chat_result.' };
  if (code === 'RATE_LIMITED') return { action: 'wait_for_manual_recovery', automatic_retry: false, message: 'Do not resend. Inspect the original page; a completed ChatGPT answer can be read with chat_result without clearing the breaker. New actions require confirmed recovery before clearing the circuit breaker.' };
  if (code === 'LOGIN_REQUIRED') return { action: 'manual_login', automatic_retry: false, message: 'Sign in manually in the dedicated browser, then resume this task. Never provide credentials to a tool.' };
  if (task.provider === 'chatgpt' && (code === 'LEGACY_IDENTITY_UNVERIFIED' ||
      (code === 'SEND_UNCONFIRMED' && !task.targetUserMessageId))) {
    return { action: 'inspect_then_baseline_abandon_or_recover', automatic_retry: false,
      message: 'No stable per-message ID was persisted; this is not a missing Windows/user identity setting. Do not resend. Inspect the original dedicated ChatGPT page. If it is exactly unchanged from the saved baseline and idle, the command node src/cli.js abandon <task_id> --confirm rechecks URL, counts, baseline hashes/IDs and generation ownership before releasing tracking. If the submitted prompt is visible, do not abandon; recover only by calling chat_result with the same task_id and exact conversation_url when the original page contains exactly one completed, unclaimed first turn.' };
  }
  if (code === 'CONTROL_BUSY') {
    if (task.error?.retryable_observation === true) return { action: 'chat_result', retry_after_ms: 5000, automatic_retry: false, message: 'wait=true retries this read-only controller-cleanup condition within the same timeoutMs budget. If it remains busy after the observation budget, reconnect and read the same task_id. Never resend.' };
    return { action: 'inspect_page', automatic_retry: false, message: 'The controller became busy after result reconciliation crossed its settlement boundary. Do not automatically repeat the operation. Reconnect MCP, inspect the original task page, then resume the same task_id if its state is clear.' };
  }
  if (code === 'RESULT_TIMEOUT') return { action: 'chat_result', automatic_retry: false, message: 'The observation budget expired. Read the same task_id with chat_result; this does not resend or confirm completion.' };
  if (task.state === 'uncertain') return { action: 'inspect_page', automatic_retry: false, message: 'Inspect the original page, then call chat_result. Do not resend with a new request_id. Abandon tracking only after explicit user authorization.' };
  return { action: 'chat_result', automatic_retry: false, message: 'Resume observation with this task_id. A wait timeout does not cancel or resend the task.' };
}
