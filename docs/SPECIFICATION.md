# PAAIR Project Specification

Version 1.0 / March 2026

## 1. Executive Summary

PAAIR (Personal Assistant Artificial Intelligence for Ricardo) is a locally hosted, privacy-first AI agent designed to manage email correspondence and calendar scheduling during periods of absence. The system operates on an opt-in basis: correspondents are informed via an out-of-office message that they may choose to interact with PAAIR by forwarding relevant email chains to a dedicated address (assistant@paair.ricardotwumasi.com), keeping Ricardo in CC at all times.

The core design philosophy prioritises data sovereignty, transparency, and minimal attack surface. PAAIR runs entirely on local hardware, processes only email context explicitly shared with it by correspondents, and maintains no persistent memory of conversations beyond the immediate exchange.

## 2. System Overview and Design Principles

### 2.1 Operational Concept

PAAIR functions as an asynchronous email agent. When Ricardo is away, his out-of-office message informs correspondents of the option to engage PAAIR. Those who opt in forward their query to the PAAIR email address. A workflow automation tool (n8n, self-hosted) detects the inbound email via webhook, extracts the content, and passes it to a locally running large language model. The model generates a response, which is sent back to the correspondent via the Resend API, with Ricardo always in CC. For calendar-related queries, PAAIR checks free/busy information via the Microsoft Graph API and suggests available meeting times without creating events directly.

### 2.2 Design Principles

**Opt-in only.** No correspondent is forced to interact with PAAIR. The system only processes emails that are explicitly forwarded to its address. This is both an ethical safeguard and a practical one, ensuring that sensitive communications (particularly those relating to student welfare, as specified in the out-of-office message) are never processed by the AI.

**Local-first processing.** All inference runs on Ricardo's MacBook Pro (16GB unified memory) using a quantised open-weight model via Ollama with MLX acceleration. No email content is transmitted to third-party AI providers. The only external API calls are to Resend (for email delivery), Microsoft Graph (for calendar free/busy queries), and Telegram (for escalation notifications).

**Transparency.** Every email sent by PAAIR includes a clear footer identifying it as an AI-generated response, disclosing the model used, and reminding the recipient that they may wait for a human response if preferred.

**Minimal permissions.** PAAIR has read-only access to calendar free/busy data (not full event details) and no ability to create, modify, or delete calendar entries. Email sending is mediated through a dedicated Resend account with rate limiting.

## 3. Local Model Selection

### 3.1 Hardware Constraints

The primary deployment target is a MacBook Pro with 16GB of unified memory. Apple Silicon's unified memory architecture provides meaningful advantages for local LLM inference, as the GPU and CPU share the same memory pool without the overhead of data transfer between discrete components. With the MLX framework, inference speeds of approximately 30-50 tokens per second are achievable with 7-9B parameter models at Q4_K_M or Q5_K_M quantisation levels.

The secondary hardware option, an NVIDIA L40S with 48GB VRAM, is a shared resource available for 2-6 hours daily. It may serve as a batch-processing environment for fine-tuning or for handling a queue of more complex queries.

### 3.2 Recommended Models

| Model | Parameters | VRAM (Q5_K_M) | Strengths | Recommendation |
|-------|-----------|---------------|-----------|----------------|
| Qwen3.5 9B | 9B | ~9-10 GB | Best-in-class tool use and function calling; supports reasoning mode; strong instruction following | Primary choice |
| Llama 3.3 8B Instruct | 8B | ~9-10 GB | Mature ecosystem; extensive community; solid general instruction following | Strong alternative |
| Mistral Small 3 (7B) | 7B | ~7-8 GB | Fastest inference on consumer hardware; excellent instruction following; lightest footprint | Best for speed |
| Phi-4-mini (3.8B) | 3.8B | ~4 GB | Remarkable capability for size; built-in function calling; minimal resource use | Fallback / concurrent use |

The primary recommendation is Qwen3.5 9B at Q5_K_M quantisation. This model occupies approximately 9-10 GB of unified memory, leaving adequate headroom for the operating system and the n8n workflow engine. Its distinguishing feature is superior performance on agentic benchmarks, particularly tool use and function calling, which are essential for PAAIR's ability to invoke calendar APIs and compose structured email responses.

A critical caveat: Q4_K_M quantisation has been observed to cause tool-call repetition loops in some models. Q5_K_M is therefore the recommended quantisation level.

### 3.3 Models for the L40S (Batch Processing)

Should the L40S be used for batch processing or fine-tuning, larger models become available: Qwen3.5 27B (Q4_K_M, approximately 17 GB VRAM) or Llama 3.3 70B (Q4_K_M, approximately 42-45 GB VRAM). For fine-tuning via QLoRA, the L40S can comfortably train 7-9B models with a dataset of 500-1,000 high-quality email instruction examples.

## 4. Inference Framework

The recommended inference stack is Ollama with MLX backend. Ollama provides a clean REST API (OpenAI-compatible) that the workflow engine can call directly, handles model management and quantisation transparently, and supports structured output via JSON schema constraints, streaming with tool calling, and native agentic loops.

The Ollama API exposes endpoints at localhost:11434. The key endpoints for PAAIR are `/api/chat` (for conversational inference with tool definitions) and `/api/generate` (for single-turn completions).

## 5. System Architecture

### 5.1 Component Overview

| Component | Technology | Role | Runs Locally? |
|-----------|-----------|------|---------------|
| Email Ingestion | Resend Inbound Webhooks | Receives emails sent to assistant@paair.ricardotwumasi.com | Partially (webhook endpoint local, Resend servers receive mail) |
| Workflow Orchestration | n8n (self-hosted, Docker) | Routes inbound email to LLM, handles retry logic, rate limiting, and response dispatch | Yes |
| LLM Inference | Ollama + MLX (Qwen3.5 9B) | Generates email responses, determines calendar query intent, formats replies | Yes |
| Calendar Access | Microsoft Graph API | Read-only free/busy queries against Ricardo's Outlook calendar | API calls only |
| Email Dispatch | Resend Send API | Sends PAAIR's responses from assistant@paair.ricardotwumasi.com with Ricardo in CC | API call only |
| Notifications | Telegram Bot API | Sends escalation alerts and handles draft approval via inline keyboards | API call only |

### 5.2 Data Flow

The end-to-end data flow proceeds as follows. A correspondent receives Ricardo's out-of-office message and opts in by forwarding their query to assistant@paair.ricardotwumasi.com with Ricardo in CC. Resend receives the inbound email and fires a webhook (HTTP POST) to the n8n instance running on Ricardo's machine, delivered via a secure tunnel (Cloudflare Tunnel or ngrok). The webhook payload contains metadata; n8n then calls the Resend Received Emails API to retrieve the full email body, headers, and any attachments.

n8n passes the email content to Ollama's /api/chat endpoint with the system prompt that defines PAAIR's persona, constraints, and available tools. The model processes the query and either generates a direct response or emits a tool call (e.g., to check calendar availability or to escalate). If a tool call is emitted, n8n executes the corresponding action (querying Microsoft Graph for free/busy data, or logging an escalation and sending a Telegram notification) and feeds the result back to the model for a second inference pass.

The completed response is sent via the Resend Send API, with the original sender as the recipient, Ricardo in CC, and the original email's Message-ID in the In-Reply-To header to maintain threading. A footer is appended disclosing the AI-generated nature of the response.

### 5.3 Webhook Exposure Strategy

Since the MacBook is behind a home or institutional network, the n8n webhook endpoint must be exposed to the internet. The recommended option is Cloudflare Tunnel (free for personal use, encrypted outbound-only connection, no inbound ports required, DDoS protection, TLS termination). The alternative is ngrok.

## 6. Integration Details

### 6.1 Email: Resend

Resend serves as both the inbound and outbound email provider. The address assistant@paair.ricardotwumasi.com receives mail, and Resend fires a webhook containing metadata (sender, subject, timestamp) to n8n. The webhook payload does not include the full email body or attachments; these must be retrieved via separate API calls to the Received Emails API and Attachments API respectively.

An alternative worth noting is Postmark, which includes the full email payload inline in the webhook POST, eliminating follow-up API calls.

### 6.2 Calendar: Microsoft Graph API

Ricardo's institution uses Microsoft 365 (Outlook). The Microsoft Graph API provides the free/busy endpoint: `GET /users/{id}/calendar/getSchedule`, which returns availability information without exposing event titles or details. This requires the `Calendars.Read` delegated permission scope, obtained via OAuth 2.0 with an Azure AD app registration.

The OAuth flow will use the device code grant with a refresh token stored securely in the macOS Keychain. Token refresh is handled by n8n's built-in OAuth2 credential management.

### 6.3 Workflow Orchestration: n8n

n8n is the workflow orchestration layer, chosen over Zapier because it is fully self-hostable, offers native integrations for Microsoft Outlook calendar and webhook-based email triggers, and provides over 1,200 pre-built integration nodes.

n8n runs as a Docker container. The primary workflow consists of a Webhook Trigger node, an HTTP Request node (fetching full email), a Code node (formatting prompt and invoking Ollama), conditional logic nodes, and HTTP Request nodes for sending responses and notifications.

### 6.4 Notifications: Telegram Bot

Telegram replaces Pushover as the primary notification channel for escalations. A dedicated Telegram bot (created via @BotFather) sends escalation alerts to Ricardo's Telegram account. Telegram was selected because it is free with no usage limits, supports rich message formatting, provides inline keyboard buttons for interactive draft approval (Approve / Edit / Discard), supports file and image attachments for forwarding email content, and is available on all platforms (iOS, Android, desktop, web).

The bot also supports a `/status` command for Ricardo to check PAAIR's current state (number of pending escalations, emails processed today, model status) and a `/pause` command to temporarily halt autonomous responses.

### 6.5 Security Considerations

Email sender verification is handled via SPF, DKIM, and DMARC checks (performed by Resend on inbound email automatically). An allowlist of trusted sender domains (configured in `config/trusted_domains.yaml`) determines which emails are processed automatically versus held for review. Rate limiting (configurable, default 20 responses per day, 5 per sender per day) is enforced at the n8n workflow level. All email content is processed in-memory with no persistent storage of email bodies. OAuth tokens for Microsoft Graph are stored in the macOS Keychain.

## 7. Relevant Open-Source References

Several existing open-source projects inform PAAIR's design. All code in PAAIR is written from scratch under the MIT licence, using these projects as architectural inspiration only.

**Inbox Zero** (github.com/elie222/inbox-zero, AGPL-3.0) is the leading open-source AI email assistant. Its patterns for email stringification (XML-tagged format for LLM consumption), prompt injection security, rule-based email triage, and thread context extraction inform PAAIR's implementation approach. See `docs/INBOX_ZERO_ANALYSIS.md` for a detailed component-by-component assessment.

**Scheduled** (github.com/mastra-ai/template-meeting-scheduler) is a purpose-built meeting scheduler that analyses email threads for meeting requests and proposes times. Its email-to-calendar flow is the closest existing pattern to PAAIR's scheduling feature.

**Calendar-MCP** (github.com/MarimerLLC/calendar-mcp) provides unified calendar access via MCP. A potential future integration if PAAIR adopts the MCP standard.

## 8. Phased Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

Install Ollama and download Qwen3.5 9B (Q5_K_M). Set up n8n via Docker. Configure Resend for assistant@paair.ricardotwumasi.com. Establish Cloudflare Tunnel. Build the initial n8n workflow: webhook trigger, email fetch, Ollama inference, Resend reply.

**Deliverable:** PAAIR can receive an email, generate a response, and send it back.

### Phase 2: Calendar Integration (Weeks 3-4)

Implement OAuth 2.0 for Microsoft Graph. Define the `check_calendar_availability` tool. Build the n8n sub-workflow for calendar queries. Modify the system prompt for calendar tool invocation.

**Deliverable:** PAAIR can respond to meeting requests with available times and discussion summaries.

### Phase 3: Safety and Notifications (Weeks 5-6)

Implement the domain allowlist. Add rate limiting. Build the Telegram bot for escalation notifications with inline keyboard approval. Implement the escalation triage logic. Add response quality checks. Build the AI-generated response footer. Add SQLite logging. Test failure modes.

**Deliverable:** PAAIR is robust enough for real-world deployment.

### Phase 4: Fine-Tuning and Persona (Weeks 7-8)

Prepare a QLoRA fine-tuning dataset (500-1,000 examples). Fine-tune Qwen3.5 9B on the L40S using Unsloth. Evaluate against a held-out test set.

**Deliverable:** PAAIR's responses reflect Ricardo's academic tone and institutional context.

### Phase 5: Extended Capabilities (Weeks 9+)

Candidate features: tentative calendar event creation, multi-turn conversation handling, attachment processing, institutional system integration, Telegram-based status dashboard, voice message transcription for Telegram-based approvals.

## 9. Revised Out-of-Office Message

> Thank you for your email. I will be away until 15th April 2026.
>
> If you would like a response before my return, you may opt in to PAAIR (Personal Assistant Artificial Intelligence for Ricardo) by forwarding this email chain, or any context you consider relevant, to assistant@paair.ricardotwumasi.com and keeping me in CC. PAAIR can respond to general queries about my research, provide information I have previously shared publicly, and check my calendar availability for scheduling meetings upon my return.
>
> PAAIR is a locally hosted AI assistant running Qwen3.5 (9B parameters) on my personal machine. It processes only the email content you explicitly share with it and does not retain conversation history. All responses are AI-generated and clearly marked as such.
>
> This is an opt-in service. If you prefer a human response, please wait until after 15th April. Please do not send student welfare-related messages to PAAIR.

## 10. Risk Assessment

**Hallucination risk:** Local models at the 7-9B scale are more prone to factual errors than larger frontier models. Mitigation: the system prompt instructs PAAIR to acknowledge uncertainty explicitly, avoid commitments, and redirect complex queries. The escalation triage provides an additional safeguard.

**Reputational risk:** Mitigation: AI-generated footer, opt-in design, CC to Ricardo, domain allowlist.

**Availability risk:** If the MacBook loses power or connectivity, PAAIR becomes unavailable. Mitigation: n8n error handling notifies Ricardo via Telegram. Correspondents receive no response, indistinguishable from a normal out-of-office.

**Data privacy risk:** Email content transits through Resend's servers. Mitigation: TLS encryption in transit, in-memory processing locally, no persistent email body storage.

## 11. Cost Estimate

Ollama, n8n (self-hosted), Microsoft Graph API, Cloudflare Tunnel, and Telegram Bot API are all free. Resend's free tier includes 100 emails per day. Total estimated operational cost: zero to negligible.
