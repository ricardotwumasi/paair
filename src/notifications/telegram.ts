import { createLogger } from '../logger.js';
import type { EscalationRecord, AppConfig, TelegramSendResult, TelegramNotificationResult } from '../types.js';

const log = createLogger('telegram');

export const URGENCY_BADGE: Record<string, string> = {
  immediate: '🚨 IMMEDIATE',
  same_day: '📋 Same Day',
  on_return: '📌 On Return',
};

export const REASON_LABEL: Record<string, string> = {
  student_welfare: 'Student Welfare',
  confidential: 'Confidential Matter',
  high_importance: 'High Importance',
  uncertainty: 'Uncertain Response',
  emotional_distress: 'Emotional Distress',
  rate_limit_exceeded: 'Rate Limit Exceeded',
};

export function formatTelegramMessage(escalation: EscalationRecord): string {
  const badge = URGENCY_BADGE[escalation.urgency] || escalation.urgency;
  const reason = REASON_LABEL[escalation.reason] || escalation.reason;

  let message = `${badge}\n\n`;
  message += `Reason: ${reason}\n`;
  message += `From: ${escalation.originalMessageId}\n\n`;
  message += `Summary:\n${escalation.summary}\n`;

  if (escalation.draftResponse) {
    const maxDraftLength = 2000;
    let draft = escalation.draftResponse;
    if (draft.length > maxDraftLength) {
      draft = draft.slice(0, maxDraftLength) + '\n[truncated]';
    }
    message += `\nDraft response:\n${draft}`;
  }

  if (message.length > 4096) {
    message = message.slice(0, 4090) + '\n[...]';
  }

  return message;
}

/**
 * Send a plain text message to Ricardo via Telegram.
 */
export async function sendTelegramMessage(
  text: string,
  config: AppConfig,
  replyMarkup?: unknown,
): Promise<TelegramSendResult> {
  const { bot_token, chat_id } = config.notifications.telegram;
  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id,
    text,
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return (await response.json()) as TelegramSendResult;
}

/**
 * Answer a Telegram callback query (removes the "loading" spinner on buttons).
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text: string,
  config: AppConfig,
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.notifications.telegram.bot_token}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

/**
 * Send an escalation notification with inline approval buttons.
 * Returns the Telegram message ID for tracking.
 */
export async function sendTelegramNotification(
  escalation: EscalationRecord,
  escalationDbId: number,
  config: AppConfig,
): Promise<TelegramNotificationResult> {
  const { enabled, bot_token, chat_id } = config.notifications.telegram;

  if (!enabled) {
    log.info('Telegram notifications disabled; skipping');
    return { success: false };
  }

  if (!bot_token || !chat_id) {
    log.warn('Telegram bot_token or chat_id not configured; skipping notification');
    return { success: false };
  }

  const message = formatTelegramMessage(escalation);

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `approve:${escalationDbId}` },
        { text: 'Edit', callback_data: `edit:${escalationDbId}` },
        { text: 'Discard', callback_data: `discard:${escalationDbId}` },
      ],
    ],
  };

  try {
    const data = await sendTelegramMessage(message, config, inlineKeyboard);

    if (!data.ok) {
      log.error('Telegram API error', { description: data.description });
      return { success: false };
    }

    const telegramMessageId = data.result?.message_id;

    log.info('Telegram notification sent with approval buttons', {
      urgency: escalation.urgency,
      reason: escalation.reason,
      telegramMessageId,
    });

    return { success: true, telegramMessageId };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Telegram send failed', { error: errorMsg });
    return { success: false };
  }
}
