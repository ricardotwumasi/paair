import { createLogger } from '../logger.js';
import { getDb } from '../utils/init_db.js';
import { sendEmailViaResend } from '../tools/send_email.js';
import { buildFooter } from '../utils/build_prompt.js';
import {
  sendTelegramMessage,
  answerCallbackQuery,
  sendTelegramNotification,
} from './telegram.js';
import { generateAndSendDigest } from './digest.js';
import type { AppConfig, TelegramUpdate, EscalationRecord } from '../types.js';

const log = createLogger('telegram-bot');

// In-memory state for "edit" flow (chatId -> escalationId)
const editState = new Map<string, number>();

const POLL_TIMEOUT = 30;
const ERROR_RETRY_DELAY = 5000;

// ─── Callback Query Handlers ───

async function handleApprove(escalationId: number, callbackQueryId: string, config: AppConfig): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT e.id as esc_id, e.draft_response, e.ricardo_action,
           em.from_address, em.subject, em.message_id
    FROM escalations e JOIN emails em ON e.email_id = em.id
    WHERE e.id = ?
  `).get(escalationId) as {
    esc_id: number; draft_response: string | null; ricardo_action: string;
    from_address: string; subject: string; message_id: string;
  } | undefined;

  if (!row) {
    await answerCallbackQuery(callbackQueryId, 'Escalation not found.', config);
    return;
  }

  if (row.ricardo_action !== 'pending') {
    await answerCallbackQuery(callbackQueryId, `Already ${row.ricardo_action}.`, config);
    return;
  }

  if (!row.draft_response) {
    await answerCallbackQuery(callbackQueryId, 'No draft response to send.', config);
    return;
  }

  try {
    const footer = buildFooter(config);
    const fullBody = row.draft_response + '\n\n---\n' + footer;

    await sendEmailViaResend(
      {
        to: row.from_address,
        subject: `Re: ${row.subject}`,
        body: row.draft_response,
        in_reply_to: row.message_id,
      },
      fullBody,
      config,
    );

    db.prepare(`
      UPDATE escalations SET ricardo_action = 'approved', resolved_at = datetime('now'), resolved_response = ?
      WHERE id = ?
    `).run(row.draft_response, escalationId);

    await answerCallbackQuery(callbackQueryId, 'Response sent.', config);
    await sendTelegramMessage(`Draft approved and sent to ${row.from_address}.`, config);
    log.info('Escalation approved', { escalationId, to: row.from_address });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await answerCallbackQuery(callbackQueryId, 'Send failed.', config);
    await sendTelegramMessage(`Failed to send: ${msg}`, config);
    log.error('Approve send failed', { escalationId, error: msg });
  }
}

async function handleEdit(escalationId: number, callbackQueryId: string, chatId: string, config: AppConfig): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT ricardo_action FROM escalations WHERE id = ?').get(escalationId) as { ricardo_action: string } | undefined;

  if (!row || row.ricardo_action !== 'pending') {
    await answerCallbackQuery(callbackQueryId, row ? `Already ${row.ricardo_action}.` : 'Not found.', config);
    return;
  }

  db.prepare("UPDATE escalations SET ricardo_action = 'editing' WHERE id = ?").run(escalationId);
  editState.set(chatId, escalationId);

  await answerCallbackQuery(callbackQueryId, 'Please type your edited response.', config);
  await sendTelegramMessage('Please type your edited response. It will be sent to the correspondent.', config);
  log.info('Escalation edit requested', { escalationId });
}

async function handleDiscard(escalationId: number, callbackQueryId: string, config: AppConfig): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT ricardo_action FROM escalations WHERE id = ?').get(escalationId) as { ricardo_action: string } | undefined;

  if (!row || (row.ricardo_action !== 'pending' && row.ricardo_action !== 'editing')) {
    await answerCallbackQuery(callbackQueryId, row ? `Already ${row.ricardo_action}.` : 'Not found.', config);
    return;
  }

  db.prepare("UPDATE escalations SET ricardo_action = 'discarded', resolved_at = datetime('now') WHERE id = ?").run(escalationId);
  editState.delete(String(config.notifications.telegram.chat_id));

  await answerCallbackQuery(callbackQueryId, 'Escalation discarded.', config);
  log.info('Escalation discarded', { escalationId });
}

async function handleFreeformMessage(text: string, chatId: string, config: AppConfig): Promise<void> {
  const escalationId = editState.get(chatId);
  if (!escalationId) return;

  const db = getDb();
  const row = db.prepare(`
    SELECT e.id, em.from_address, em.subject, em.message_id
    FROM escalations e JOIN emails em ON e.email_id = em.id
    WHERE e.id = ? AND e.ricardo_action = 'editing'
  `).get(escalationId) as {
    id: number; from_address: string; subject: string; message_id: string;
  } | undefined;

  if (!row) {
    editState.delete(chatId);
    await sendTelegramMessage('Edit session expired or escalation not found.', config);
    return;
  }

  try {
    const footer = buildFooter(config);
    const fullBody = text + '\n\n---\n' + footer;

    await sendEmailViaResend(
      {
        to: row.from_address,
        subject: `Re: ${row.subject}`,
        body: text,
        in_reply_to: row.message_id,
      },
      fullBody,
      config,
    );

    db.prepare(`
      UPDATE escalations SET ricardo_action = 'edited', resolved_at = datetime('now'), resolved_response = ?
      WHERE id = ?
    `).run(text, escalationId);

    editState.delete(chatId);
    await sendTelegramMessage(`Edited response sent to ${row.from_address}.`, config);
    log.info('Edited response sent', { escalationId, to: row.from_address });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await sendTelegramMessage(`Failed to send edited response: ${msg}`, config);
    log.error('Edit send failed', { escalationId, error: msg });
  }
}

// ─── Command Handlers ───

async function handleStatus(config: AppConfig): Promise<void> {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const emailStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN action = 'responded' THEN 1 ELSE 0 END) as responded,
      SUM(CASE WHEN action = 'escalated' THEN 1 ELSE 0 END) as escalated
    FROM emails WHERE DATE(created_at) = ?
  `).get(today) as { total: number; responded: number; escalated: number };

  const pending = db.prepare(
    "SELECT COUNT(*) as count FROM escalations WHERE ricardo_action = 'pending'"
  ).get() as { count: number };

  const state = db.prepare('SELECT paused FROM system_state WHERE id = 1').get() as { paused: number };

  let ollamaStatus = 'unknown';
  try {
    const resp = await fetch(`${config.model.endpoint}/api/tags`);
    ollamaStatus = resp.ok ? 'running' : `error (${resp.status})`;
  } catch {
    ollamaStatus = 'offline';
  }

  const msg = [
    `PAAIR Status (${today})`,
    '',
    `Emails today: ${emailStats.total}`,
    `  Responded: ${emailStats.responded || 0}`,
    `  Escalated: ${emailStats.escalated || 0}`,
    `Pending escalations: ${pending.count}`,
    `System: ${state.paused ? 'PAUSED' : 'Active'}`,
    `Ollama: ${ollamaStatus}`,
  ].join('\n');

  await sendTelegramMessage(msg, config);
}

async function handlePause(config: AppConfig): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE system_state SET paused = 1, paused_at = datetime('now') WHERE id = 1").run();
  await sendTelegramMessage('PAAIR paused. All incoming emails will be escalated for your review.', config);
  log.info('System paused via Telegram');
}

async function handleResume(config: AppConfig): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE system_state SET paused = 0, resumed_at = datetime('now') WHERE id = 1").run();
  await sendTelegramMessage('PAAIR resumed. Autonomous processing re-enabled.', config);
  log.info('System resumed via Telegram');
}

async function handlePending(config: AppConfig): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT e.id, e.reason, e.urgency, e.summary, e.draft_response,
           em.from_address, em.subject, em.message_id as original_message_id
    FROM escalations e JOIN emails em ON e.email_id = em.id
    WHERE e.ricardo_action = 'pending'
    ORDER BY e.created_at DESC LIMIT 10
  `).all() as Array<{
    id: number; reason: string; urgency: string; summary: string; draft_response: string | null;
    from_address: string; subject: string; original_message_id: string;
  }>;

  if (rows.length === 0) {
    await sendTelegramMessage('No pending escalations.', config);
    return;
  }

  await sendTelegramMessage(`${rows.length} pending escalation(s):`, config);

  for (const row of rows) {
    const escalation: EscalationRecord = {
      reason: row.reason,
      summary: row.summary,
      urgency: row.urgency as 'immediate' | 'same_day' | 'on_return',
      draftResponse: row.draft_response ?? undefined,
      originalMessageId: row.original_message_id,
      timestamp: '',
    };
    await sendTelegramNotification(escalation, row.id, config);
    // Small delay to avoid Telegram rate limiting
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// ─── Polling Loop ───

async function pollUpdates(config: AppConfig): Promise<void> {
  const { bot_token, chat_id } = config.notifications.telegram;
  const allowedChatId = String(chat_id);
  let offset = 0;

  log.info('Telegram bot polling started');

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${bot_token}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}`;
      const response = await fetch(url);
      const data = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] };

      if (!data.ok || !data.result) continue;

      for (const update of data.result) {
        offset = update.update_id + 1;

        // Security: only process updates from Ricardo's chat
        const updateChatId =
          update.callback_query?.message?.chat.id ??
          update.message?.chat.id;

        if (String(updateChatId) !== allowedChatId) continue;

        if (update.callback_query?.data) {
          const [action, idStr] = update.callback_query.data.split(':');
          const escalationId = parseInt(idStr, 10);

          if (isNaN(escalationId)) continue;

          if (action === 'approve') {
            await handleApprove(escalationId, update.callback_query.id, config);
          } else if (action === 'edit') {
            await handleEdit(escalationId, update.callback_query.id, allowedChatId, config);
          } else if (action === 'discard') {
            await handleDiscard(escalationId, update.callback_query.id, config);
          }
        } else if (update.message?.text) {
          const text = update.message.text;

          if (text === '/status') await handleStatus(config);
          else if (text === '/pause') await handlePause(config);
          else if (text === '/resume') await handleResume(config);
          else if (text === '/pending') await handlePending(config);
          else if (text === '/digest') await generateAndSendDigest(config);
          else await handleFreeformMessage(text, allowedChatId, config);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Telegram polling error', { error: msg });
      await new Promise((resolve) => setTimeout(resolve, ERROR_RETRY_DELAY));
    }
  }
}

/**
 * Start the Telegram bot long-polling loop.
 * Runs forever in the background; errors are caught and retried.
 */
export function startTelegramBot(config: AppConfig): void {
  const { enabled, bot_token, chat_id } = config.notifications.telegram;

  if (!enabled || !bot_token || !chat_id) {
    log.warn('Telegram bot not started: missing token or chat_id');
    return;
  }

  // Fire and forget; the polling loop runs indefinitely
  pollUpdates(config).catch((error) => {
    log.error('Telegram bot fatal error', { error: String(error) });
  });
}
