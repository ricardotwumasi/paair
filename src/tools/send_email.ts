import { Resend } from 'resend';
import { createLogger } from '../logger.js';
import type { SendEmailArgs, AppConfig } from '../types.js';

const log = createLogger('resend');

let _resend: Resend | null = null;

function getResendClient(apiKey: string): Resend {
  if (!_resend) {
    _resend = new Resend(apiKey);
  }
  return _resend;
}

/**
 * Send an email reply via the Resend API.
 * Always CCs Ricardo. Always plain text. Footer is pre-appended by the caller.
 * Returns the Resend message ID on success.
 */
export async function sendEmailViaResend(
  args: SendEmailArgs,
  fullBody: string,
  config: AppConfig,
): Promise<string> {
  const resend = getResendClient(config.email.resend_api_key);

  log.info('Sending email via Resend', {
    to: args.to,
    subject: args.subject,
    cc: config.email.ricardo_email,
  });

  const { data, error } = await resend.emails.send({
    from: `PAAIR <${config.email.paair_address}>`,
    to: args.to,
    cc: config.email.ricardo_email || undefined,
    subject: args.subject,
    text: fullBody,
    headers: {
      'In-Reply-To': args.in_reply_to,
      'References': args.in_reply_to,
    },
  });

  if (error) {
    log.error('Resend API error', {
      name: error.name,
      message: error.message,
    });
    throw new Error(`Resend API error: ${error.name}: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error('Resend returned no message ID');
  }

  log.info('Email sent successfully', { resendMessageId: data.id });
  return data.id;
}
