import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { initDatabase } from './utils/init_db.js';
import { inboundEmailSchema } from './types.js';
import type { InboundEmail, AppConfig } from './types.js';
import { processEmail } from './pipeline/process.js';
import { startTelegramBot } from './notifications/telegram_bot.js';
import { generateAndSendDigest } from './notifications/digest.js';

const log = createLogger('server');
const PORT = Number(process.env.PAAIR_PORT) || 3100;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Fetch the full email content from Resend's Email API.
 * The webhook only contains metadata; the body must be fetched separately.
 */
async function fetchEmailBody(emailId: string, config: AppConfig): Promise<string> {
  log.info('Fetching email body from Resend', { emailId });

  // Resend inbound emails use /emails/receiving/{id}, not /emails/{id}
  const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${config.email.resend_api_key}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error('Failed to fetch email from Resend', { emailId, status: response.status, error: errorText });
    throw new Error(`Resend fetch error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { text?: string; html?: string };
  const body = data.text ?? data.html ?? '';

  if (!body) {
    log.warn('Email body is empty', { emailId });
  }

  return body;
}

/**
 * Transform Resend's webhook payload into our InboundEmail format.
 * Resend sends: { type: "email.received", data: { from, to: [], subject, message_id, email_id, created_at } }
 * We need: { from, to, subject, text, messageId, date }
 */
async function transformResendPayload(
  payload: Record<string, unknown>,
  config: AppConfig,
): Promise<InboundEmail> {
  const data = (payload.data ?? payload) as Record<string, unknown>;

  // Fetch the email body using the email_id
  const emailId = data.email_id as string;
  let text = '';
  if (emailId) {
    text = await fetchEmailBody(emailId, config);
  }

  const transformed = {
    from: data.from as string,
    to: Array.isArray(data.to) ? (data.to as string[])[0] : (data.to as string),
    subject: (data.subject as string) || '(no subject)',
    text,
    messageId: (data.message_id as string) || (data.email_id as string) || '',
    date: (data.created_at as string) || new Date().toISOString(),
  };

  return inboundEmailSchema.parse(transformed);
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = getConfig();

  // Validate webhook secret if configured
  if (config.webhook.secret) {
    const providedSecret = req.headers['x-webhook-secret'] as string | undefined;
    if (providedSecret !== config.webhook.secret) {
      log.warn('Webhook secret mismatch');
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  const body = await readBody(req);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  log.info('Webhook received', {
    type: parsed.type,
    emailId: parsed.data?.email_id,
    dataKeys: Object.keys(parsed.data ?? {}),
    hasText: Boolean(parsed.data?.text),
    hasHtml: Boolean(parsed.data?.html),
    hasBody: Boolean(parsed.data?.body),
    fullData: JSON.stringify(parsed.data ?? {}).slice(0, 3000),
  });

  // Only process email.received events
  if (parsed.type && parsed.type !== 'email.received') {
    log.info('Ignoring non-email webhook event', { type: parsed.type });
    sendJson(res, 200, { status: 'ignored', type: parsed.type });
    return;
  }

  let email: InboundEmail;
  try {
    email = await transformResendPayload(parsed, config);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error('Failed to transform webhook payload', { error: errorMsg });
    sendJson(res, 400, { error: 'Invalid payload', message: errorMsg });
    return;
  }

  log.info('Processing inbound email', { from: email.from, subject: email.subject });

  try {
    const result = await processEmail(email);
    sendJson(res, 200, result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Handle duplicate emails gracefully
    if (errorMsg.includes('UNIQUE constraint failed')) {
      log.info('Duplicate email ignored', { messageId: email.messageId });
      sendJson(res, 200, { status: 'duplicate', emailId: email.messageId });
      return;
    }
    log.error('Pipeline error', { error: errorMsg });
    sendJson(res, 500, { error: 'Processing failed', message: errorMsg });
  }
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, url } = req;
  log.debug('Request received', { method, url });

  if (method === 'GET' && url === '/health') {
    handleHealth(req, res);
    return;
  }

  if (method === 'POST' && url === '/webhook/paair-inbound') {
    await handleWebhook(req, res);
    return;
  }

  if (method === 'POST' && url === '/webhook/paair-digest') {
    try {
      const config = getConfig();
      const result = await generateAndSendDigest(config);
      sendJson(res, 200, result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Digest error', { error: errorMsg });
      sendJson(res, 500, { error: 'Digest failed', message: errorMsg });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ─── Server Startup ───

function start(): void {
  const config = getConfig();
  initDatabase(config.logging.database);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Unhandled request error', { error: errorMsg });
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(PORT, () => {
    log.info(`PAAIR server started on port ${PORT}`, {
      webhookPath: config.webhook.path,
      model: config.model.name,
      returnDate: config.absence.return_date,
    });

    // Start Telegram bot polling in the background
    startTelegramBot(config);
  });
}

start();
