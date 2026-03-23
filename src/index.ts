import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { initDatabase } from './utils/init_db.js';
import { inboundEmailSchema } from './types.js';
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
  } else {
    log.warn('No webhook secret configured; skipping validation');
  }

  const body = await readBody(req);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const validation = inboundEmailSchema.safeParse(parsed);
  if (!validation.success) {
    log.warn('Invalid webhook payload', { errors: validation.error.issues });
    sendJson(res, 400, { error: 'Invalid payload', details: validation.error.issues });
    return;
  }

  const email = validation.data;

  try {
    const result = await processEmail(email);
    sendJson(res, 200, result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
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
