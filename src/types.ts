import { z } from 'zod';

// ─── Inbound Email (from Resend webhook) ───

export interface ThreadMessage {
  from: string;
  date: string;
  body: string;
}

export interface InboundEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  date: string;
  headers?: Record<string, string>;
  threadHistory?: ThreadMessage[];
}

export const inboundEmailSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  subject: z.string().default('(no subject)'),
  text: z.string().default(''),
  html: z.string().optional(),
  messageId: z.string().min(1),
  date: z.string().min(1),
  headers: z.record(z.string()).optional(),
  threadHistory: z
    .array(
      z.object({
        from: z.string(),
        date: z.string(),
        body: z.string(),
      }),
    )
    .optional(),
});

// ─── Ollama API Types ───

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

export interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export const ollamaChatResponseSchema = z.object({
  message: z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().default(''),
    tool_calls: z
      .array(
        z.object({
          function: z.object({
            name: z.string(),
            arguments: z.record(z.unknown()),
          }),
        }),
      )
      .optional(),
  }),
  done: z.boolean(),
  total_duration: z.number().optional(),
  eval_count: z.number().optional(),
});

// ─── Tool Call Argument Schemas ───

export const offerBookingLinkArgsSchema = z.object({
  duration_preference: z.enum(['short', 'medium', 'long']),
  context: z.string(),
});
export type OfferBookingLinkArgs = z.infer<typeof offerBookingLinkArgsSchema>;

export const escalateArgsSchema = z.object({
  reason: z.enum([
    'student_welfare',
    'confidential',
    'high_importance',
    'uncertainty',
    'emotional_distress',
    'rate_limit_exceeded',
  ]),
  summary: z.string(),
  urgency: z.enum(['immediate', 'same_day', 'on_return']),
  draft_response: z.string().optional(),
  original_message_id: z.string(),
});
export type EscalateArgs = z.infer<typeof escalateArgsSchema>;

export const sendEmailArgsSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  in_reply_to: z.string(),
});
export type SendEmailArgs = z.infer<typeof sendEmailArgsSchema>;

// ─── Processing Result ───

export type ProcessingAction =
  | 'responded'
  | 'escalated'
  | 'calendar_pending'
  | 'rate_limited'
  | 'blocked'
  | 'error';

export interface EscalationRecord {
  reason: string;
  summary: string;
  urgency: 'immediate' | 'same_day' | 'on_return';
  draftResponse?: string;
  originalMessageId: string;
  timestamp: string;
}

export interface ProcessingResult {
  action: ProcessingAction;
  emailId: string;
  responseBody?: string;
  escalation?: EscalationRecord;
  error?: string;
  durationMs: number;
}

// ─── Config Types ───

export interface ModelConfig {
  name: string;
  endpoint: string;
  temperature: number;
  max_tokens: number;
  context_window: number;
}

export interface EmailConfig {
  paair_address: string;
  ricardo_email: string;
  resend_api_key: string;
}

export interface BookingLinksConfig {
  phone_15min: string;
  meeting_25min: string;
  meeting_50min: string;
}

export interface TelegramConfig {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
}

export interface EmailDigestConfig {
  enabled: boolean;
  recipient: string;
  digest_time: string;
  timezone: string;
}

export interface NotificationsConfig {
  telegram: TelegramConfig;
  email_digest: EmailDigestConfig;
}

export interface SafetyConfig {
  max_responses_per_day: number;
  max_per_sender_per_day: number;
  domain_mode: 'allow' | 'warn';
}

export interface AbsenceConfig {
  return_date: string;
  fallback_contact_name: string;
  fallback_contact_email: string;
  ricardo_surname: string;
}

export interface WebhookConfig {
  external_url: string;
  path: string;
  secret: string;
}

export interface LoggingConfig {
  database: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  log_email_bodies: boolean;
}

export interface AppConfig {
  model: ModelConfig;
  email: EmailConfig;
  booking_links: BookingLinksConfig;
  notifications: NotificationsConfig;
  safety: SafetyConfig;
  absence: AbsenceConfig;
  webhook: WebhookConfig;
  logging: LoggingConfig;
  trustedDomains: string[];
  blockedDomains: string[];
}

// ─── Telegram API Types ───

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number }; text?: string };
    data?: string;
  };
  message?: {
    message_id: number;
    from: { id: number };
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}

export interface TelegramSendResult {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

export interface TelegramNotificationResult {
  success: boolean;
  telegramMessageId?: number;
}

// ─── Digest Types ───

export interface DigestResult {
  totalEmails: number;
  responded: number;
  escalated: number;
  pendingEscalations: number;
  telegramSent: boolean;
}
