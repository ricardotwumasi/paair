# PAAIR Escalation and Notification Workflow

## Overview

When PAAIR determines that a message requires Ricardo's personal attention, it invokes the `escalate_to_ricardo` tool. This document specifies what happens on the backend when that tool is called.

## Notification Tiers

### Immediate

Triggered by: student welfare, emotional distress, time-sensitive high-importance requests.

Actions:
1. Log the escalation to the local SQLite database (timestamp, reason, sender, subject, summary, draft response, message ID).
2. Send a push notification to Ricardo's mobile device via Pushover (https://pushover.net). The notification includes the reason category, sender name, subject line, and the 2-3 sentence summary. Pushover was chosen because it supports priority levels (emergency notifications can require acknowledgement), works on iOS, Android, and desktop, and costs a one-time fee of $5 per platform with no subscription.
3. Send an email to Ricardo's personal (non-institutional) email address with the full escalation details, including the draft response for review.
4. Hold the draft response in a pending state in the SQLite database, keyed by message ID.

### Same Day

Triggered by: confidential matters, high-importance items without explicit time pressure, rate-limit-exceeded escalations.

Actions:
1. Log to SQLite as above.
2. Add to the daily digest queue.
3. At 18:00 (or a configurable time), send a single digest email to Ricardo's personal email containing all same-day escalations, each with its summary and draft response.
4. Hold all draft responses pending approval.

### On Return

Triggered by: uncertainty about a response, low-urgency queries that fall outside PAAIR's scope.

Actions:
1. Log to SQLite as above.
2. Add to the return briefing queue.
3. On Ricardo's configured return date, send a comprehensive briefing email listing all on-return escalations, grouped by category, with summaries and draft responses.

## Draft Approval Mechanism

When Ricardo receives an escalation notification (by any tier), he can approve, edit, or discard the draft response. The simplest implementation for v1 is a reply-based approval system:

1. The escalation email to Ricardo includes the draft response in a clearly marked block.
2. Ricardo can:
   - Reply with "APPROVE" to send the draft as-is.
   - Reply with "APPROVE:" followed by edited text to send a modified version.
   - Reply with "DISCARD" to suppress the response (the correspondent receives nothing further).
   - Reply with his own freeform response, which is forwarded to the correspondent directly (bypassing PAAIR).

3. The n8n workflow monitors Ricardo's personal email for replies to escalation notifications. When a reply is detected, it parses the instruction and executes accordingly via the Resend Send API.

For v2, a simple web dashboard (local, served by n8n or a lightweight Express server) could provide a more ergonomic approval interface with one-click approve/edit/discard buttons.

## Pushover Configuration

Service: https://pushover.net
Integration type: REST API (simple HTTP POST)
Endpoint: https://api.pushover.net/1/messages.json

Required parameters:
- `token`: PAAIR application API token (registered at pushover.net)
- `user`: Ricardo's Pushover user key
- `message`: Escalation summary
- `title`: "PAAIR Escalation: [reason]"
- `priority`: 0 (normal) for same_day, 1 (high) for immediate, 2 (emergency with retry) for student welfare
- `url`: Optional link to the escalation in the web dashboard (v2)

The Pushover API is free after the one-time $5 app purchase and supports up to 10,000 messages per month, which is far beyond PAAIR's expected escalation volume.

## Rate Limiting Integration

The system prompt instructs PAAIR to escalate after 5 messages from the same sender in a single day. The orchestration layer (n8n) should independently enforce this by:

1. Maintaining a counter per sender email address per calendar day in the SQLite database.
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
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, edited, discarded, expired
    approved_at TEXT,
    approved_response TEXT,
    notification_sent INTEGER DEFAULT 0,
    digest_included INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS response_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    message_id TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    subject TEXT,
    response_type TEXT NOT NULL,  -- autonomous, escalated_approved, escalated_edited, rate_limited
    model_input_tokens INTEGER,
    model_output_tokens INTEGER,
    tools_invoked TEXT,  -- JSON array of tool names used
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
