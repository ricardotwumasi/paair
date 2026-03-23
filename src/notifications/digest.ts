import { createLogger } from '../logger.js';
import { getDb } from '../utils/init_db.js';
import { sendTelegramMessage, sendTelegramNotification } from './telegram.js';
import type { AppConfig, DigestResult, EscalationRecord } from '../types.js';

const log = createLogger('digest');

/**
 * Generate and send a daily digest via Telegram.
 * Summarises emails processed, responses sent, and escalation statuses.
 * Re-sends pending escalations with approval buttons.
 */
export async function generateAndSendDigest(config: AppConfig): Promise<DigestResult> {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const emailStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN action = 'responded' THEN 1 ELSE 0 END) as responded,
      SUM(CASE WHEN action = 'escalated' THEN 1 ELSE 0 END) as escalated,
      SUM(CASE WHEN action = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited,
      SUM(CASE WHEN action = 'blocked' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN action = 'error' THEN 1 ELSE 0 END) as errors
    FROM emails WHERE DATE(created_at) = ?
  `).get(today) as {
    total: number; responded: number; escalated: number;
    rate_limited: number; blocked: number; errors: number;
  };

  const escalations = db.prepare(`
    SELECT e.id, e.reason, e.urgency, e.summary, e.draft_response, e.ricardo_action,
           em.from_address, em.subject, em.message_id as original_message_id
    FROM escalations e JOIN emails em ON e.email_id = em.id
    WHERE DATE(e.created_at) = ?
    ORDER BY e.created_at
  `).all(today) as Array<{
    id: number; reason: string; urgency: string; summary: string;
    draft_response: string | null; ricardo_action: string;
    from_address: string; subject: string; original_message_id: string;
  }>;

  const pendingCount = escalations.filter((e) => e.ricardo_action === 'pending').length;

  // Build digest message
  const lines = [
    `Daily Digest (${today})`,
    '',
    `Emails processed: ${emailStats.total}`,
  ];

  if (emailStats.total > 0) {
    lines.push(`  Responded: ${emailStats.responded || 0}`);
    lines.push(`  Escalated: ${emailStats.escalated || 0}`);
    if (emailStats.rate_limited) lines.push(`  Rate limited: ${emailStats.rate_limited}`);
    if (emailStats.blocked) lines.push(`  Blocked: ${emailStats.blocked}`);
    if (emailStats.errors) lines.push(`  Errors: ${emailStats.errors}`);
  }

  if (escalations.length > 0) {
    lines.push('');
    lines.push('Escalations:');
    for (const esc of escalations) {
      const status = esc.ricardo_action.toUpperCase();
      lines.push(`  [${status}] ${esc.reason} - ${esc.from_address} - "${esc.subject}"`);
    }
  }

  if (pendingCount > 0) {
    lines.push('');
    lines.push(`${pendingCount} escalation(s) still pending your review.`);
  }

  const digestMessage = lines.join('\n');
  let telegramSent = false;

  try {
    const result = await sendTelegramMessage(digestMessage, config);
    telegramSent = result.ok;

    // Re-send pending escalations with approval buttons
    const pendingEscalations = escalations.filter((e) => e.ricardo_action === 'pending');
    for (const esc of pendingEscalations) {
      const record: EscalationRecord = {
        reason: esc.reason,
        summary: esc.summary,
        urgency: esc.urgency as 'immediate' | 'same_day' | 'on_return',
        draftResponse: esc.draft_response ?? undefined,
        originalMessageId: esc.original_message_id,
        timestamp: '',
      };
      await sendTelegramNotification(record, esc.id, config);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    log.info('Daily digest sent', { total: emailStats.total, pending: pendingCount });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to send digest', { error: msg });
  }

  return {
    totalEmails: emailStats.total,
    responded: emailStats.responded || 0,
    escalated: emailStats.escalated || 0,
    pendingEscalations: pendingCount,
    telegramSent,
  };
}
