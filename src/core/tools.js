import { z } from 'zod';
import { Fanout } from './fanout.js';
import { diagnose } from './diagnostics.js';
import { safeControlDiagnostics } from '../shared/browser-diagnostics.js';

function createProgressNotifier(extra) {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;
  if (progressToken === undefined || progressToken === null || typeof sendNotification !== 'function') return undefined;

  let sequence = 0;
  let lastKey = null;
  let lastSentAt = 0;
  let queue = Promise.resolve();

  return (progress, task) => {
    if (!progress) return;
    const phase = progress.phase || task?.state || 'waiting';
    const responseChars = Number.isFinite(progress.response_chars) ? progress.response_chars : 0;
    const key = `${phase}:${responseChars}`;
    const now = Date.now();
    if (key === lastKey && now - lastSentAt < 30_000) return;

    lastKey = key;
    lastSentAt = now;
    sequence += 1;
    const elapsedMs = Number.isFinite(task?.created_at) ? Math.max(0, now - task.created_at) : 0;
    const notification = {
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: sequence,
        message: `phase=${phase}; elapsed_ms=${elapsedMs}; response_chars=${responseChars}`,
      },
    };

    // Transport writes are serialized so sequence numbers cannot overtake.
    // Notification failures must never fail or delay the underlying task.
    queue = queue.then(() => sendNotification(notification)).catch(() => {});
  };
}

export function registerWebFirstTools(server, kernel) {
  const fanout = new Fanout(kernel);
  const providerNames = [...kernel.providers.keys()];
  if (!providerNames.includes('chatgpt')) throw new Error('The ChatGPT provider is required for the default chat_send route.');
  const provider = z.enum(providerNames).default('chatgpt');
  const session_id = z.string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
    .optional()
    .describe('Stable caller-chosen project session. Reuse it for follow-ups; use a different value for an independent conversation.');

  const tool = (name, description, schema, handler) => server.registerTool(
    name,
    { description, inputSchema: z.strictObject(schema) },
    async (input, extra = {}) => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await handler(input, extra.signal, extra), null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({
              code: error.code || 'CHAT_ERROR',
              error: error.message,
              ...(error.safeDiagnostics ? { diagnostics: safeControlDiagnostics(error.safeDiagnostics) } : {}),
            }),
          }],
        };
      }
    },
  );

  // The public MCP surface is intentionally fixed at four tools.
  // Provider-specific lifecycle and recovery operations remain available via CLI.
  tool(
    'chat_send',
    'Primary Web-First reasoning entry. Use for substantive analysis, research, architecture, design, technical choices, root-cause analysis, debugging strategy and implementation planning before local agents make design decisions. Returns a durable task_id after one submission. Reuse a stable session_id per project and a new request_id per new logical request. After uncertainty, replay only the exact same request_id and payload; never create a replacement send. Provider defaults to ChatGPT; choose Gemini only when explicitly requested. ChatGPT defaults to GPT-6 + 高 when model, thinking_level and answer_tier are omitted.',
    {
      provider: z.enum(providerNames).optional(),
      providers: z.array(z.enum(providerNames)).length(2).optional()
        .describe('Explicitly send the same prompt and files to both listed providers. Mutually exclusive with provider and single-provider settings.'),
      session_id,
      request_id: z.string().min(1).max(128),
      prompt: z.string().min(1),
      files: z.array(z.string().min(1)).max(10).default([]),
      model: z.string().min(1).optional(),
      thinking_level: z.string().min(1).optional(),
      answer_tier: z.string().min(1).optional(),
      web_search: z.boolean().default(false),
      existing_draft: z.boolean().default(false),
    },
    (input, signal) => input.providers !== undefined
      ? fanout.send(input, { signal })
      : kernel.send({ ...input, provider: input.provider ?? 'chatgpt' }, { signal }),
  );

  tool(
    'chat_result',
    'Read or resume an existing durable task; this tool never sends a prompt. Defaults to wait=true and a 90-second observation slice. timed_out means only that this observation slice ended; it does not mean generation failed or was cancelled. Continue with the same task_id within the caller’s bounded total wait budget. Never resend uncertain work. CONTROL_BUSY is retried read-only inside the same slice only when the server confirms it occurred before the settlement boundary. If the slice ends with retryable_observation=true, the caller may open another slice for the same task_id within its total wait budget.',
    {
      task_id: z.string(),
      wait: z.boolean().default(true),
      refresh: z.boolean().default(false),
      conversation_url: z.string().url().optional(),
      timeoutMs: z.number().int().min(1_000).max(300_000).default(90_000),
    },
    (input, signal, extra) => input.task_id.startsWith('fanout:') ? fanout.result(input.task_id, { ...input, signal }) : kernel.result(input.task_id, {
      ...input,
      signal,
      onProgress: createProgressNotifier(extra),
    }),
  );

  tool(
    'chat_history',
    'Read conversation history for the selected provider/session. Results include provider-specific scope and completeness information; do not assume unloaded history is complete. This is read-only and does not create, switch or send a conversation.',
    {
      provider,
      session_id,
      query: z.string().default(''),
      limit: z.number().int().min(1).max(50).default(20),
    },
    (input, signal) => kernel.run(
      input.provider,
      async browser => {
        const history = await browser.listHistory({ query: input.query, limit: input.limit });
        return {
          ...history,
          provider: input.provider,
          session_id: input.session_id ?? null,
          scope: history.scope ?? 'currently loaded sidebar',
          complete: history.complete ?? false,
        };
      },
      { signal, readOnly: true, sessionId: input.session_id, name: 'chat_history' },
    ),
  );

  tool(
    'chat_doctor',
    'Inspect local executable, runtime, browser discovery and task-journal health. This is local-only: it does not open a browser, verify website sign-in, or send a message.',
    { provider: z.enum(providerNames).optional() },
    input => diagnose(kernel, input.provider ? [input.provider] : undefined),
  );
}
