# PAAIR

**Personal Assistant Artificial Intelligence for Ricardo**

A locally hosted, privacy-first AI email agent that responds to correspondence during periods of absence. PAAIR processes only emails that correspondents explicitly opt in to send, runs entirely on local hardware, and never connects to cloud LLM providers.

## How It Works

1. Ricardo sets an out-of-office message inviting correspondents to opt in
2. Those who opt in forward their query to `assistant@paair.ricardotwumasi.com` (keeping Ricardo in CC)
3. PAAIR receives the email via Resend webhook, processes it with a local LLM (Qwen3.5 9B via Ollama), and responds
4. For meeting requests, PAAIR checks Ricardo's calendar (read-only) and proposes available times with a discussion summary
5. Sensitive matters (student welfare, HR, urgent decisions) are escalated to Ricardo via Telegram with a draft response for approval

## Architecture

```
Correspondent --> Resend Inbound --> Cloudflare Tunnel --> n8n Webhook
                                                             |
                                                             v
                                                     Email Processing
                                                             |
                                              +--------------+--------------+
                                              |              |              |
                                          Autonomous     Calendar       Escalate
                                              |          Query            |
                                              |              |            |
                                              v              v            v
                                          Resend Send   Graph API    Telegram Bot
                                          (reply)       (free/busy)  (notify Ricardo)
                                              |              |            |
                                              v              v            v
                                          Correspondent   Feed back    Hold draft
                                          receives        to LLM       for approval
                                          response        then reply
```

## Key Principles

- **Opt-in only:** No inbox access; processes only explicitly forwarded emails
- **Local-first:** All LLM inference runs on-device via Ollama; no cloud AI API calls
- **Transparent:** Every response identifies itself as AI-generated
- **Safe by default:** Student welfare and sensitive matters always escalate to a human
- **Minimal permissions:** Read-only calendar access (free/busy only)

## Quick Start

```bash
# Prerequisites: Docker, Node.js 20+, Ollama
git clone https://github.com/[your-username]/paair.git
cd paair
./scripts/setup.sh
cp .env.example .env
# Edit .env with your API keys
docker compose up -d
npx tsx src/index.ts
```

## Configuration

See `config/settings.yaml` for all configurable parameters including model selection, rate limits, trusted domains, and notification preferences.

## Documentation

- [Project Specification](docs/SPECIFICATION.md) - Full technical specification
- [Escalation Workflow](docs/ESCALATION.md) - How notifications and draft approval work
- [Inbox Zero Analysis](docs/INBOX_ZERO_ANALYSIS.md) - Architectural patterns borrowed from Inbox Zero
- [System Prompt](prompts/system.md) - The LLM's persona and instructions

## Licence

MIT. See [LICENCE](LICENCE) for details.

This project draws architectural inspiration (not code) from [Inbox Zero](https://github.com/elie222/inbox-zero) (AGPL-3.0). All code in this repository is original work, reimplemented from scratch under the MIT licence.
