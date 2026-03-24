import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { getDb } from '../utils/init_db.js';
import { formatEmailForLLM, extractSenderAddress, extractSenderDomain, extractSenderName } from '../utils/format_email.js';
import { buildSystemPrompt, buildFooter } from '../utils/build_prompt.js';
import { chatWithTools, loadToolDefinitions } from '../ollama/client.js';
import { sendEmailViaResend } from '../tools/send_email.js';
import { selectBookingLink } from '../tools/calendar.js';
import { sendTelegramNotification } from '../notifications/telegram.js';
import { getRelevantResearchContext } from '../utils/research_context.js';
import {
  offerBookingLinkArgsSchema,
  escalateArgsSchema,
  sendEmailArgsSchema,
} from '../types.js';
import type {
  InboundEmail,
  ProcessingResult,
  EscalationRecord,
  OllamaMessage,
  SendEmailArgs,
  EscalateArgs,
  OfferBookingLinkArgs,
} from '../types.js';

const log = createLogger('pipeline');
const MAX_TOOL_ITERATIONS = 3;

// ─── Rate Limiting ───

function checkRateLimits(senderAddress: string): { allowed: boolean; reason?: string } {
  const config = getConfig();
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  // Global daily limit
  const globalCount = db
    .prepare('SELECT COALESCE(SUM(count), 0) as total FROM rate_limits WHERE date = ?')
    .get(today) as { total: number };

  if (globalCount.total >= config.safety.max_responses_per_day) {
    return { allowed: false, reason: `Global daily limit reached (${config.safety.max_responses_per_day})` };
  }

  // Per-sender daily limit
  const senderCount = db
    .prepare('SELECT COALESCE(count, 0) as count FROM rate_limits WHERE sender_address = ? AND date = ?')
    .get(senderAddress, today) as { count: number } | undefined;

  if (senderCount && senderCount.count >= config.safety.max_per_sender_per_day) {
    return { allowed: false, reason: `Per-sender daily limit reached (${config.safety.max_per_sender_per_day})` };
  }

  return { allowed: true };
}

function incrementRateLimit(senderAddress: string): void {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  db.prepare(
    `INSERT INTO rate_limits (sender_address, date, count)
     VALUES (?, ?, 1)
     ON CONFLICT(sender_address, date) DO UPDATE SET count = count + 1`,
  ).run(senderAddress, today);
}

// ─── Database Logging ───

function logEmail(email: InboundEmail, senderAddress: string): number {
  const config = getConfig();
  const db = getDb();

  const result = db
    .prepare(
      `INSERT INTO emails (message_id, from_address, to_address, subject, received_at, body_logged, body_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      email.messageId,
      senderAddress,
      email.to,
      email.subject,
      email.date,
      config.logging.log_email_bodies ? 1 : 0,
      config.logging.log_email_bodies ? email.text : null,
    );

  return Number(result.lastInsertRowid);
}

function logLlmAudit(
  emailDbId: number,
  requestMessages: OllamaMessage[],
  responseContent: string,
  toolCalls: string | null,
  model: string,
  durationMs: number,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO llm_audit (email_id, request_messages, response_content, tool_calls, model, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    emailDbId,
    JSON.stringify(requestMessages),
    responseContent,
    toolCalls,
    model,
    durationMs,
  );
}

function logResponse(emailDbId: number, responseBody: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO responses (email_id, response_body, created_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(emailDbId, responseBody);
}

function logEscalation(emailDbId: number, args: EscalateArgs): number {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO escalations (email_id, reason, summary, urgency, draft_response)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(emailDbId, args.reason, args.summary, args.urgency, args.draft_response ?? null);
  return Number(result.lastInsertRowid);
}

function updateEmailAction(emailDbId: number, action: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE emails SET action = ?, processed_at = datetime('now') WHERE id = ?`,
  ).run(action, emailDbId);
}

// ─── Tool Handlers ───

function stripModelFooter(body: string): string {
  let lines = body.split('\n');

  // Strip footer blocks (after "---" that mention PAAIR/AI assistant)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---' && i + 1 < lines.length) {
      const rest = lines.slice(i + 1).join('\n').toLowerCase();
      if (rest.includes('paair') || rest.includes('ai assistant') || rest.includes('locally hosted')) {
        lines = lines.slice(0, i);
        break;
      }
    }
  }

  // Strip signature blocks: look for lines matching a title/institution pattern
  // e.g. "**Ricardo Twumasi**", "Lecturer in Psychosis", "King's College London"
  const sigPatterns = [
    /^\*{0,2}(dr\s+)?ricardo\s+twumasi\*{0,2}$/i,
    /^(lecturer|professor|reader|senior\s+lecturer)\s+in\s+/i,
    /^department\s+of\s+/i,
    /^(institute|faculty)\s+of\s+/i,
    /^king'?s\s+college\s+london/i,
    /^email:\s+/i,
    /^website:\s+/i,
    /^tel(ephone)?:\s+/i,
    /^return\s+from\s+absence/i,
  ];

  let sigStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue; // skip blank lines at end
    const isSigLine = sigPatterns.some((p) => p.test(trimmed));
    if (isSigLine) {
      sigStart = i;
    } else {
      break; // stop scanning once we hit a non-signature line
    }
  }

  if (sigStart >= 0) {
    // Also strip any "---" separator line immediately before the signature
    if (sigStart > 0 && lines[sigStart - 1].trim() === '---') {
      sigStart--;
    }
    lines = lines.slice(0, sigStart);
  }

  // Strip literal [FOOTER] marker if the model included it
  let result = lines.join('\n').trimEnd();
  result = result.replace(/\n?\[FOOTER\]\s*$/i, '').trimEnd();
  return result;
}

async function handleSendEmail(args: SendEmailArgs, emailDbId: number): Promise<string> {
  const config = getConfig();
  const db = getDb();
  const footer = buildFooter(config);
  const cleanBody = stripModelFooter(args.body);
  const fullBody = cleanBody + '\n\n---\n' + footer;

  try {
    const resendMessageId = await sendEmailViaResend(args, fullBody, config);

    db.prepare(
      `INSERT INTO responses (email_id, response_body, resend_message_id, sent_at, created_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(emailDbId, fullBody, resendMessageId);

    return fullBody;
  } catch (error) {
    // Log the response even if sending failed (for audit)
    logResponse(emailDbId, fullBody);
    throw error;
  }
}

async function handleEscalation(args: EscalateArgs, emailDbId: number): Promise<EscalationRecord> {
  const config = getConfig();
  const escalationDbId = logEscalation(emailDbId, args);

  const escalation: EscalationRecord = {
    reason: args.reason,
    summary: args.summary,
    urgency: args.urgency,
    draftResponse: args.draft_response,
    originalMessageId: args.original_message_id,
    timestamp: new Date().toISOString(),
  };

  // Send Telegram notification with approval buttons
  const result = await sendTelegramNotification(escalation, escalationDbId, config);
  if (result.success) {
    const db = getDb();
    db.prepare(
      `UPDATE escalations SET telegram_notified = 1, telegram_message_id = ? WHERE id = ?`,
    ).run(result.telegramMessageId ?? null, escalationDbId);
  }

  return escalation;
}

function handleBookingLink(args: OfferBookingLinkArgs): string {
  const config = getConfig();
  return selectBookingLink(args, config);
}

// ─── Core Pipeline ───

export async function processEmail(email: InboundEmail): Promise<ProcessingResult> {
  const startTime = Date.now();
  const config = getConfig();
  const senderAddress = extractSenderAddress(email.from);
  const senderDomain = extractSenderDomain(email.from);

  log.info('Processing email', {
    from: senderAddress,
    subject: email.subject,
    messageId: email.messageId,
  });

  // Check if system is paused
  const db = getDb();
  const systemState = db.prepare('SELECT paused FROM system_state WHERE id = 1').get() as { paused: number } | undefined;
  if (systemState?.paused) {
    log.info('System paused; force-escalating email');
    const emailDbId = logEmail(email, senderAddress);
    const escalation = await handleEscalation(
      {
        reason: 'uncertainty',
        summary: `System paused. Email held for manual review. From: ${senderAddress}, Subject: ${email.subject}`,
        urgency: 'same_day',
        original_message_id: email.messageId,
      },
      emailDbId,
    );
    updateEmailAction(emailDbId, 'escalated');
    return {
      action: 'escalated',
      emailId: email.messageId,
      escalation,
      durationMs: Date.now() - startTime,
    };
  }

  // Check blocked domains
  if (config.blockedDomains.includes(senderDomain)) {
    log.warn('Email from blocked domain', { domain: senderDomain });
    return {
      action: 'blocked',
      emailId: email.messageId,
      durationMs: Date.now() - startTime,
    };
  }

  // Check rate limits
  const rateCheck = checkRateLimits(senderAddress);
  if (!rateCheck.allowed) {
    log.warn('Rate limit exceeded', { sender: senderAddress, reason: rateCheck.reason });

    const emailDbId = logEmail(email, senderAddress);

    // Auto-escalate rate-limited emails
    const escalation = await handleEscalation(
      {
        reason: 'rate_limit_exceeded',
        summary: `Rate limit exceeded for ${senderAddress}: ${rateCheck.reason}`,
        urgency: 'same_day',
        original_message_id: email.messageId,
      },
      emailDbId,
    );

    updateEmailAction(emailDbId, 'rate_limited');

    return {
      action: 'rate_limited',
      emailId: email.messageId,
      escalation,
      durationMs: Date.now() - startTime,
    };
  }

  // Log email to database
  const emailDbId = logEmail(email, senderAddress);

  // Domain trust warning
  if (
    config.safety.domain_mode === 'warn' &&
    !config.trustedDomains.includes(senderDomain)
  ) {
    log.warn('Email from untrusted domain (processing in warn mode)', {
      domain: senderDomain,
    });
  }

  // Build messages for Ollama
  const systemPrompt = buildSystemPrompt(config);
  const emailContext = formatEmailForLLM(email);
  const senderName = extractSenderName(email.from);

  // Inject per-email context variables into a user-facing preamble
  let userMessage =
    `The following email has been received. The sender is ${senderName} (${senderAddress}). ` +
    `Today's date is ${new Date().toISOString().split('T')[0]}.\n\n` +
    emailContext;

  // Inject relevant research context if available
  const researchContext = getRelevantResearchContext(email.subject + ' ' + email.text);
  if (researchContext) {
    userMessage += '\n\n' + researchContext;
  }

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const tools = loadToolDefinitions();

  // Tool-calling loop (max iterations to prevent infinite loops)
  let iteration = 0;
  let finalResult: ProcessingResult | null = null;

  while (iteration < MAX_TOOL_ITERATIONS && !finalResult) {
    iteration++;

    const llmStartTime = Date.now();
    let response;

    try {
      response = await chatWithTools(messages, tools);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Ollama request failed', { error: errorMsg, iteration });
      updateEmailAction(emailDbId, 'error');
      return {
        action: 'error',
        emailId: email.messageId,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }

    const llmDurationMs = Date.now() - llmStartTime;

    // Log LLM audit
    logLlmAudit(
      emailDbId,
      messages,
      response.message.content,
      response.message.tool_calls ? JSON.stringify(response.message.tool_calls) : null,
      config.model.name,
      llmDurationMs,
    );

    // Process tool calls
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      // Add assistant message with tool calls to conversation
      messages.push(response.message);

      for (const toolCall of response.message.tool_calls) {
        const { name, arguments: args } = toolCall.function;
        log.info('Tool call received', { tool: name, iteration });

        try {
          if (name === 'send_email_reply') {
            const validated = sendEmailArgsSchema.parse(args);
            const responseBody = await handleSendEmail(validated, emailDbId);
            incrementRateLimit(senderAddress);
            updateEmailAction(emailDbId, 'responded');

            finalResult = {
              action: 'responded',
              emailId: email.messageId,
              responseBody,
              durationMs: Date.now() - startTime,
            };
          } else if (name === 'escalate_to_ricardo') {
            const validated = escalateArgsSchema.parse(args);
            const escalation = await handleEscalation(validated, emailDbId);
            updateEmailAction(emailDbId, 'escalated');

            finalResult = {
              action: 'escalated',
              emailId: email.messageId,
              escalation,
              durationMs: Date.now() - startTime,
            };
          } else if (name === 'offer_booking_link') {
            const validated = offerBookingLinkArgsSchema.parse(args);
            const bookingResult = handleBookingLink(validated);

            // Feed booking link result back into conversation
            messages.push({
              role: 'tool',
              content: bookingResult,
            });

            // Continue loop; model will generate a follow-up response with the link
          } else {
            log.warn('Unknown tool call', { tool: name });
          }
        } catch (validationError) {
          const errorMsg =
            validationError instanceof Error
              ? validationError.message
              : String(validationError);
          log.error('Tool call argument validation failed', {
            tool: name,
            error: errorMsg,
            args: JSON.stringify(args),
          });
        }
      }
    } else if (response.message.content) {
      // Model returned text without tool calls.
      // This is common with some models; send the response via Resend directly.
      log.warn(
        'Model returned text without tool call; sending as direct response',
        { contentLength: response.message.content.length },
      );

      const cleanContent = stripModelFooter(response.message.content);

      try {
        const responseBody = await handleSendEmail(
          {
            to: senderAddress,
            subject: `Re: ${email.subject}`,
            body: cleanContent,
            in_reply_to: email.messageId,
          },
          emailDbId,
        );
        incrementRateLimit(senderAddress);
        updateEmailAction(emailDbId, 'responded');

        finalResult = {
          action: 'responded',
          emailId: email.messageId,
          responseBody,
          durationMs: Date.now() - startTime,
        };
      } catch (sendError) {
        const sendErrorMsg = sendError instanceof Error ? sendError.message : String(sendError);
        log.error('Failed to send direct response', { error: sendErrorMsg });
        // Fall back to logging only
        const footer = buildFooter(config);
        const fullBody = cleanContent + '\n\n---\n' + footer;
        logResponse(emailDbId, fullBody);
        updateEmailAction(emailDbId, 'error');

        finalResult = {
          action: 'error',
          emailId: email.messageId,
          responseBody: fullBody,
          error: sendErrorMsg,
          durationMs: Date.now() - startTime,
        };
      }
    } else {
      log.error('Empty response from model', { iteration });
      updateEmailAction(emailDbId, 'error');
      finalResult = {
        action: 'error',
        emailId: email.messageId,
        error: 'Empty response from model',
        durationMs: Date.now() - startTime,
      };
    }
  }

  // If we exhausted iterations without a final result (calendar loop didn't converge)
  if (!finalResult) {
    log.error('Max tool iterations reached without resolution');
    updateEmailAction(emailDbId, 'error');
    return {
      action: 'error',
      emailId: email.messageId,
      error: `Max tool iterations (${MAX_TOOL_ITERATIONS}) reached without resolution`,
      durationMs: Date.now() - startTime,
    };
  }

  log.info('Email processing complete', {
    action: finalResult.action,
    durationMs: finalResult.durationMs,
  });

  return finalResult;
}
