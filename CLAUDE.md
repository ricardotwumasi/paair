# PAAIR - Claude Code Project Instructions

## What is PAAIR?

PAAIR (Personal Assistant Artificial Intelligence for Ricardo) is a locally hosted, privacy-first AI email agent. It responds to emails on behalf of Dr Ricardo during periods of absence. It is NOT an inbox manager. It processes only emails that correspondents explicitly opt in to send to a dedicated Resend address.

## Core Architecture

- **Email ingestion:** Resend inbound webhooks (p.a.a.i.r@melarxe.resend.app)
- **Orchestration:** n8n (self-hosted via Docker)
- **LLM inference:** Ollama + MLX running Qwen3.5 9B (Q5_K_M quantisation), localhost:11434
- **Calendar:** Microsoft Graph API, read-only free/busy via OAuth 2.0
- **Email sending:** Resend Send API
- **Notifications:** Telegram Bot API (primary) + email digest (secondary)
- **Webhook exposure:** Cloudflare Tunnel (preferred) or ngrok
- **Database:** SQLite (local, in ./logs/paair.db)
- **Licence:** MIT

## Critical Design Constraints

1. **No inbox access.** PAAIR never connects to Ricardo's email inbox. It only processes emails sent to p.a.a.i.r@melarxe.resend.app.
2. **No external LLM API calls.** All inference runs locally via Ollama. Never call OpenAI, Anthropic, or any cloud LLM API.
3. **Always CC Ricardo.** Every outbound email must CC Ricardo's institutional address.
4. **Plain text only.** All email responses are plain text. Never generate HTML emails or markdown-rendered emails.
5. **Escalation over autonomy.** When in doubt, escalate to Ricardo via Telegram. False positives are acceptable; false negatives on welfare/sensitive matters are not.
6. **No em dashes.** Use semicolons, colons, or full stops instead. This applies to all generated content.

## Key Files

- `CLAUDE.md` - This file (project instructions for Claude Code)
- `README.md` - Project documentation
- `prompts/system.md` - The LLM system prompt (defines PAAIR's persona, rules, escalation triggers)
- `prompts/tool_definitions.json` - Ollama tool/function calling schemas
- `config/settings.yaml` - Central configuration (model, email, limits, Telegram)
- `config/trusted_domains.yaml` - Allowlist of sender domains for auto-processing
- `docker-compose.yml` - Docker services (n8n)
- `src/tools/` - Tool implementations (calendar, email, escalation)
- `src/utils/` - Utility functions (email formatting, thread parsing)
- `src/notifications/` - Telegram bot and notification dispatch
- `workflows/` - n8n workflow JSON exports
- `scripts/` - Setup, testing, and maintenance scripts
- `docs/` - Architecture documents and analysis

## Tech Stack

- **Language:** TypeScript (primary), with shell scripts for setup
- **Runtime:** Node.js 20+
- **Package manager:** npm
- **Database:** better-sqlite3
- **HTTP client:** undici (Node.js built-in) or node-fetch
- **Schema validation:** zod
- **Testing:** vitest

## Development Patterns

### Ollama API Calls

Always use localhost:11434. The key endpoints are:

```
POST http://localhost:11434/api/chat   - Conversational inference with tool calling
POST http://localhost:11434/api/generate - Single-turn completions
```

For tool calling, pass the tools array from `prompts/tool_definitions.json` in the request body. Parse tool call responses and execute the corresponding function in `src/tools/`.

### Email Processing Pipeline

1. Resend webhook fires to n8n
2. n8n fetches full email via Resend Received Emails API
3. n8n calls PAAIR's processing endpoint (or Code node runs inline)
4. Email is formatted using `src/utils/format_email.ts` (XML-tagged structure)
5. Triage pass: model determines escalate vs. autonomous vs. calendar
6. If autonomous: generate response, send via Resend
7. If escalate: log to SQLite, send Telegram notification, hold draft
8. If calendar: call Microsoft Graph, feed result back to model, then respond

### Inbox Zero Patterns (Reference, Not Direct Copy)

This project draws architectural inspiration from Inbox Zero (github.com/elie222/inbox-zero, AGPL-3.0). We do NOT copy code directly. Instead, we reimplement the following patterns from scratch under MIT licence:

- **Email stringification:** XML-tagged format for LLM consumption (inspired by `utils/stringify-email.ts`)
- **Prompt security:** Input sanitisation for untrusted email content (inspired by `utils/ai/security.ts`)
- **Rule-based triage:** Structured rule matching with JSON output validation (inspired by `utils/ai/choose-rule/`)
- **Thread context extraction:** Parsing email chains into structured history (inspired by reply context collector)

### Notification System

Telegram is the primary notification channel for escalations. The bot sends:
- Immediate alerts for student welfare and urgent matters
- Same-day digest summaries
- Return briefing compilations

Draft approval is handled via Telegram inline keyboard buttons (Approve / Edit / Discard).

## Environment Variables

Required environment variables are documented in `.env.example`. Never commit `.env` files. Store secrets in:
- macOS Keychain for OAuth tokens
- `.env` file (gitignored) for API keys during development

## Running the Project

```bash
# First-time setup
./scripts/setup.sh

# Start services
docker compose up -d

# Run PAAIR processing (development mode)
npx tsx src/index.ts

# Run tests
npx vitest
```

## Coding Style

- Use TypeScript strict mode
- Prefer async/await over callbacks or raw promises
- Use zod for all external data validation
- Log all LLM inputs and outputs to SQLite for audit
- Handle errors explicitly; never swallow exceptions silently
- Write JSDoc comments for all exported functions
