import { createLogger } from '../logger.js';
import type { EscalationRecord, AppConfig } from '../types.js';

const log = createLogger('telegram');

const URGENCY_BADGE: Record<string, string> = {
  immediate: '🚨 IMMEDIATE',
  same_day: '📋 Same Day',
  on_return: '📌 On Return',
};

const REASON_LABEL: Record<string, string> = {
  student_welfare: 'Student Welfare',
  confidential: 'Confidential Matter',
  high_importance: 'High Importance',
  uncertainty: 'Uncertain Response',
  emotional_distress: 'Emotional Distress',
  rate_limit_exceeded: 'Rate Limit Exceeded',
};

function formatTelegramMessage(escalation: EscalationRecord): string {
  const badge = URGENCY_BADGE[escalation.urgency] || escalation.urgency;
  const reason = REASON_LABEL[escalation.reason] || escalation.reason;

  let message = `${badge}\n\n`;
  message += `Reason: ${reason}\n`;
  message += `From: ${escalation.originalMessageId}\n\n`;
  message += `Summary:\n${escalation.summary}\n`;

  if (escalation.draftResponse) {
    // Truncate draft if too long for Telegram (4096 char limit)
    const maxDraftLength = 2000;
    let draft = escalation.draftResponse;
    if (draft.length > maxDraftLength) {
      draft = draft.slice(0, maxDraftLength) + '\n[truncated]';
    }
    message += `\nDraft response:\n${draft}`;
  }

  // Telegram message limit is 4096 characters
  if (message.length > 4096) {
    message = message.slice(0, 4090) + '\n[...]';
  }

  return message;
}

/**
 * Send an escalation notification to Ricardo via the Telegram Bot API.
 * Sends all urgency levels immediately (digest batching deferred to Phase 3).
 */
export async function sendTelegramNotification(
  escalation: EscalationRecord,
  config: AppConfig,
): Promise<boolean> {
  const { bot_token, chat_id, enabled } = config.notifications.telegram;

  if (!enabled) {
    log.info('Telegram notifications disabled; skipping');
    return false;
  }

  if (!bot_token || !chat_id) {
    log.warn('Telegram bot_token or chat_id not configured; skipping notification');
    return false;
  }

  const message = formatTelegramMessage(escalation);
  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat_id,
        text: message,
        parse_mode: undefined, // Plain text; MarkdownV2 escaping is fragile
      }),
    });

    const data = await response.json() as { ok: boolean; description?: string };

    if (!data.ok) {
      log.error('Telegram API error', { description: data.description });
      return false;
    }

    log.info('Telegram notification sent', {
      urgency: escalation.urgency,
      reason: escalation.reason,
    });
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Telegram send failed', { error: errorMsg });
    return false;
  }
}
