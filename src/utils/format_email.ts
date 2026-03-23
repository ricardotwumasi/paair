import type { InboundEmail } from '../types.js';
import { sanitiseForLLM, sanitiseEmailAddress } from './sanitise.js';

/**
 * Extract the bare email address from a "Name <email>" string.
 */
export function extractSenderAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase().trim() : from.toLowerCase().trim();
}

/**
 * Extract the domain from a sender address or "Name <email>" string.
 */
export function extractSenderDomain(from: string): string {
  const address = extractSenderAddress(from);
  const parts = address.split('@');
  return parts.length > 1 ? parts[1] : '';
}

/**
 * Extract the display name from a "Name <email>" string.
 * Returns the email address if no display name is present.
 */
export function extractSenderName(from: string): string {
  const match = from.match(/^(.+?)\s*<[^>]+>/);
  if (match) {
    return match[1].replace(/^["']|["']$/g, '').trim();
  }
  return extractSenderAddress(from);
}

function formatThreadHistory(history: InboundEmail['threadHistory']): string {
  if (!history || history.length === 0) return '';

  const messages = history
    .map(
      (msg) =>
        `<previous_message>\n<from>${sanitiseForLLM(msg.from)}</from>\n<date>${msg.date}</date>\n<body>\n${sanitiseForLLM(msg.body)}\n</body>\n</previous_message>`,
    )
    .join('\n');

  return `<thread_history>\n${messages}\n</thread_history>\n\n`;
}

/**
 * Format an inbound email into XML-tagged text for LLM consumption.
 * All user-provided fields are sanitised against prompt injection.
 */
export function formatEmailForLLM(email: InboundEmail): string {
  const threadContext = formatThreadHistory(email.threadHistory);

  const formatted = [
    threadContext,
    '<email>',
    `<from>${sanitiseForLLM(sanitiseEmailAddress(email.from))}</from>`,
    `<to>${sanitiseEmailAddress(email.to)}</to>`,
    `<subject>${sanitiseForLLM(email.subject)}</subject>`,
    `<date>${email.date}</date>`,
    `<message_id>${email.messageId}</message_id>`,
    '<body>',
    sanitiseForLLM(email.text),
    '</body>',
    '</email>',
  ].join('\n');

  return formatted;
}
