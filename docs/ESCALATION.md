# PAAIR Escalation and Notification Workflow

## Overview

When PAAIR determines that a message requires Ricardo's personal attention, it invokes the `escalate_to_ricardo` tool. This document specifies what happens on the backend when that tool is called.

## Notification Channels

### Primary: Telegram Bot

A dedicated Telegram bot (created via @BotFather) serves as the primary notification and approval channel. Telegram was selected over alternatives (Pushover, email-only) for the following reasons: it is entirely free with no usage limits or per-platform fees; it supports inline keyboard buttons enabling one-tap draft approval directly from the notification; it provides rich message formatting (bold, italic, code blocks) for readable escalation summaries; it supports bot commands for system management (`/status`, `/pause`, `/resume`); and it is available on iOS, Android, desktop, and web.

### Secondary: Email Digest

For same-day and on-return escalations, a digest email is sent to Ricardo's personal email address as a backup channel.

## Notification Tiers

### Immediate

Triggered by: student welfare, emotional distress, time-sensitive high-importance requests.

Actions:

1. Log the escalation to the local SQLite database (timestamp, reason, sender, subject, summary, draft response, message ID).
2. Send a Telegram message to Ricardo containing: the reason category (with a visual indicator: a red circle for student welfare, an orange circle for high importance), the sender name and email, the subject line, the 2-3 sentence summary, and the draft response in a quoted block.
3. Attach an inline keyboard with three buttons: "Approve", "Edit", "Discard".
4. Send a backup email to Ricardo's personal email address with the same content.
5. Hold the draft response in a pending state in the SQLite database.

### Same Day

Triggered by: confidential matters, high-importance items without explicit time pressure, rate-limit-exceeded escalations.

Actions:

1. Log to SQLite as above.
2. Add to the daily digest queue.
3. At 18:00 (configurable), send a single Telegram message and a digest email containing all same-day escalations, each with its summary and draft response.
4. Each escalation in the digest has its own Approve/Edit/Discard inline keyboard.
5. Hold all draft responses pending approval.

### On Return

Triggered by: uncertainty about a response, low-urgency queries outside PAAIR's scope.

Actions:

1. Log to SQLite as above.
2. Add to the return briefing queue.
3. On Ricardo's configured return date, send a comprehensive briefing via Telegram and email listing all on-return escalations, grouped by category.

## Draft Approval via Telegram

When Ricardo receives an escalation notification with inline keyboard buttons:

**Approve:** Tapping "Approve" sends the draft response as-is to the correspondent via Resend. The bot replies with a confirmation message.

**Edit:** Tapping "Edit" prompts Ricardo to type an edited response in the Telegram chat. The bot then sends Ricardo's edited text to the correspondent. The flow is: tap "Edit" -> bot replies "Please type your response" -> Ricardo types response -> bot confirms and sends via Resend.

**Discard:** Tapping "Discard" suppresses the response entirely. The correspondent receives nothing further. The bot confirms the discard.

**Freeform reply:** If Ricardo simply replies to the escalation message in Telegram (without tapping a button), the bot interprets this as a freeform response and sends it to the correspondent directly, bypassing PAAIR's system prompt.

All approval actions are logged to SQLite with timestamp and action taken.

## Telegram Bot Commands

The bot responds to the following commands from Ricardo:

`/status` - Returns: number of emails processed today, number of pending escalations, number of autonomous responses sent, current model status (running/stopped), rate limit status.

`/pause` - Temporarily halts all autonomous responses. Incoming emails are queued and held for manual review. The bot confirms with "PAAIR paused. All incoming emails will be held for your review."

`/resume` - Resumes autonomous processing. Queued emails are processed in order. The bot confirms with "PAAIR resumed. Processing N queued emails."

`/pending` - Lists all escalations awaiting approval, each with inline keyboard buttons.

`/digest` - Triggers an immediate digest of all unprocessed same-day and on-return escalations.

## Telegram Bot Setup

1. Message @BotFather on Telegram to create a new bot.
2. Name it "PAAIR" or "PAAIR Assistant".
3. Save the bot token to `.env` as `TELEGRAM_BOT_TOKEN`.
4. Send any message to your new bot, then call the Telegram API to get your chat ID: `https://api.telegram.org/bot<TOKEN>/getUpdates`. Save the chat ID to `.env` as `TELEGRAM_CHAT_ID`.
5. The bot only responds to messages from the configured chat ID (Ricardo's account). Messages from other Telegram users are ignored.

## Rate Limiting Integration

The system prompt instructs PAAIR to escalate after 5 messages from the same sender in a single day. The orchestration layer (n8n) independently enforces this by:

1. Maintaining a counter per sender email address per calendar day in SQLite.
2. Before passing an email to the LLM, checking if the sender has already received 5 responses today.
3. If the limit is reached, skipping LLM inference entirely and sending a templated response: "Thank you for your message. PAAIR has reached its daily response limit for this conversation. Ricardo will be able to follow up with you after [RETURN DATE]. If this is urgent, please contact [FALLBACK CONTACT]."
4. Logging the rate-limited message as an escalation with reason "rate_limit_exceeded" and urgency "on_return".

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    message_id TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    sender_name TEXT,
    subject TEXT,
    reason TEXT NOT NULL,
    urgency TEXT NOT NULL,
    summary TEXT NOT NULL,
    draft_response TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    approved_at TEXT,
    approved_response TEXT,
    notification_sent INTEGER DEFAULT 0,
    telegram_message_id INTEGER,
    digest_included INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS response_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    message_id TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    subject TEXT,
    response_type TEXT NOT NULL,
    model_input_tokens INTEGER,
    model_output_tokens INTEGER,
    tools_invoked TEXT,
    response_sent INTEGER DEFAULT 0,
    resend_message_id TEXT
);

CREATE TABLE IF NOT EXISTS daily_counts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(date, sender_email)
);

CREATE INDEX idx_escalations_status ON escalations(status);
CREATE INDEX idx_escalations_urgency ON escalations(urgency);
CREATE INDEX idx_daily_counts_lookup ON daily_counts(date, sender_email);
```
