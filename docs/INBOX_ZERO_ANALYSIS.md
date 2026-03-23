# Inbox Zero Fork-and-Reuse Analysis for PAAIR

## 1. Architectural Comparison

Inbox Zero is a full Next.js monorepo application comprising approximately 35 API routes, a PostgreSQL database with Prisma ORM, Redis caching, and a React frontend. It is designed as a comprehensive inbox management platform: it connects directly to a user's Gmail or Outlook inbox via OAuth, monitors all incoming email via webhooks, applies AI-powered rules to categorise and act on every message, and provides a web dashboard for managing the entire workflow.

PAAIR, by contrast, is a narrowly scoped, opt-in email responder with no inbox access. It processes only emails that correspondents explicitly forward to a dedicated Resend address. It runs a local LLM (Qwen3.5 9B via Ollama) rather than calling external AI APIs. Its orchestration layer is n8n rather than a Next.js API server. These are fundamental architectural divergences that make a wholesale fork impractical; however, several discrete components within Inbox Zero are well-isolated and directly applicable to PAAIR's needs.

## 2. Components Worth Forking

### 2.1 Email Stringification Layer (`apps/web/utils/stringify-email.ts`)

**What it does:** Converts raw email objects (headers, body, attachments, metadata) into structured text suitable for LLM consumption. The primary function, `stringifyEmail()`, produces an XML-tagged representation with from, replyTo, to, cc, date, subject, body (with whitespace normalisation and length truncation), and attachment metadata. A simpler variant, `stringifyEmailSimple()`, provides a minimal from/subject/body format.

**Why PAAIR needs this:** When n8n receives an inbound email from Resend and passes it to Ollama, the email must be converted from raw JSON into a text format the model can reason about. This conversion is a solved problem in Inbox Zero. The XML-tagged format is particularly well-suited to structured extraction because local models at the 7-9B scale perform measurably better on inputs with explicit field delineation than on unstructured text blobs.

**Adaptation required:** Minimal. Strip the TypeScript type dependencies and convert to a standalone function. The Resend webhook payload uses slightly different field names from Gmail/Outlook objects, so the property mappings will need adjustment. Estimated effort: 1-2 hours.

### 2.2 Prompt Security Instructions (`apps/web/utils/ai/security.ts`)

**What it does:** Exports two constants. `PROMPT_SECURITY_INSTRUCTIONS` is a block of text prepended to any system prompt that processes untrusted email content; it instructs the model to distinguish legitimate business requests from prompt injection attempts, and to never reveal system instructions or act outside its defined role. `PLAIN_TEXT_OUTPUT_INSTRUCTION` constrains the model to generate plain text only, preventing phishing via deceptive HTML links.

**Why PAAIR needs this:** PAAIR processes email content from external senders, which is an inherently adversarial input channel. Prompt injection via crafted email body text is a well-documented attack vector. These security constants represent a production-tested mitigation. The plain-text output constraint is equally important; if PAAIR were to generate an HTML email containing a masked hyperlink, the reputational damage to Ricardo would be severe.

**Adaptation required:** None for the security instructions; they are framework-agnostic strings. For the output constraint, PAAIR should adopt an even stricter policy: all responses are plain text, no HTML emails, no markdown rendering. The constant can be used verbatim.

### 2.3 Rule Selection Architecture (`apps/web/utils/ai/choose-rule/ai-choose-rule.ts`)

**What it does:** Implements a structured approach to routing emails through AI-powered rules. The system takes an email and a set of named rules (each with instructions), presents them to the LLM with a carefully engineered prompt, and uses Zod schema validation to enforce structured output (rule name, reasoning, and a boolean for no-match). It supports both single-rule and multi-rule selection modes.

**Why PAAIR needs this:** PAAIR's escalation logic is fundamentally a rule selection problem. Given an inbound email, the model must decide whether to: (a) respond autonomously, (b) escalate as student welfare, (c) escalate as high importance, (d) escalate as confidential, or (e) invoke the calendar tool. Inbox Zero's pattern of presenting named rules with instructions and requiring a structured JSON response maps directly to this requirement.

**Adaptation required:** Moderate. The rule definitions change entirely (PAAIR's rules are the escalation triggers, not user-defined inbox rules). The LLM calling mechanism changes from the Vercel AI SDK's `generateObject` to Ollama's native `/api/chat` endpoint with JSON mode or tool calling. However, the prompting pattern (present rules as XML-tagged name/instruction pairs, require structured reasoning in the response, validate with a schema) is directly portable. The Zod schemas are also useful if PAAIR's n8n Code nodes use TypeScript. Estimated effort: 3-4 hours.

### 2.4 Reply Context Collection (`apps/web/utils/ai/reply/reply-context-collector.ts`)

**What it does:** Gathers contextual information relevant to composing an email reply: the thread history, sender relationship metadata, any previous interactions, and relevant knowledge base entries. This context is then injected into the LLM prompt alongside the email being replied to.

**Why PAAIR needs this:** When PAAIR receives a forwarded email chain, the chain often contains multiple messages. The context collector pattern (extracting the most recent message, summarising prior thread history, identifying the sender's relationship to Ricardo) is directly applicable. PAAIR's meeting summary generation feature particularly benefits from this: to generate a meaningful discussion summary, the model needs structured access to the conversation context, not just the final message.

**Adaptation required:** Moderate. PAAIR has no database of sender relationships or knowledge base (unlike Inbox Zero), so those data sources are stripped. The core logic of parsing an email chain into structured thread history, identifying the most recent message versus quoted earlier messages, and truncating to a manageable context window is the valuable part. Estimated effort: 2-3 hours.

### 2.5 Meeting Briefs Architecture (`apps/web/app/api/meeting-briefs/` and `apps/web/utils/meeting-briefs/`)

**What it does:** A cron-driven system that checks connected calendars for upcoming meetings, collects relevant email threads involving the meeting's attendees, and generates a pre-meeting brief summarising the context. The route handler at `api/meeting-briefs/route.ts` orchestrates per-user processing via `processMeetingBriefings()`, which queries the Prisma database for accounts with briefings enabled and calendar connections active.

**Why PAAIR needs this:** PAAIR's specification requires it to generate meeting discussion summaries when scheduling meetings. While PAAIR's version is simpler (it derives the summary from the email chain rather than scanning an entire inbox), the architectural pattern of extracting meeting context, structuring it for LLM consumption, and formatting the output as a brief is directly applicable.

**Adaptation required:** Significant restructuring but the concept is portable. PAAIR does not have a Prisma database, cron infrastructure, or inbox-wide email scanning. The valuable components are: (a) the prompt template for generating a meeting brief from contextual information, and (b) the output formatting pattern. The data source changes entirely (from calendar + inbox scan to the content of the forwarded email chain). Estimated effort: 3-4 hours.

### 2.6 Docker Compose Self-Hosting Configuration (`docker-compose.yml`)

**What it does:** Defines a five-service Docker deployment: PostgreSQL 16, Redis, a Redis HTTP wrapper (for Upstash compatibility), the main web application, and a cron container that hits the web service's scheduled endpoints at regular intervals.

**Why PAAIR needs this:** PAAIR also requires a Docker-based deployment (for n8n and potentially a lightweight database). The docker-compose structure, particularly the cron pattern (an Alpine container using curl to trigger endpoints on a schedule) and the PostgreSQL health check configuration, can be adapted for PAAIR's architecture.

**Adaptation required:** Replace the web service with n8n's official Docker image. Replace PostgreSQL with SQLite (PAAIR's data volume does not justify a separate database server, though PostgreSQL could be retained if preferred). Remove Redis (PAAIR has no caching requirements in v1). Retain the cron container pattern for scheduled tasks (e.g., sending the daily digest of escalated messages). Estimated effort: 1-2 hours.

### 2.7 Resend Package (`packages/resend/`)

**What it does:** A thin wrapper around the Resend API for sending transactional emails. Contains a client initialisation module, a contacts module, an index file, and a send function (notably implemented as a `.tsx` file, suggesting it uses React Email for templating).

**Why PAAIR needs this:** PAAIR uses Resend for both inbound and outbound email. The client initialisation and send logic can be reused. The React Email templating approach is overkill for PAAIR's plain-text responses, but the underlying Resend API wrapper (authentication, error handling, rate limit management) is directly useful.

**Adaptation required:** Strip the React Email templating and replace with plain text composition. Add inbound email retrieval functions (Resend's Received Emails API), which are not present in Inbox Zero's package (it uses Gmail/Outlook webhooks for inbound, not Resend). Estimated effort: 2-3 hours.

## 3. Components to Study but Not Fork

### 3.1 LLM Abstraction Layer (`apps/web/utils/llms/`)

Inbox Zero's LLM layer wraps the Vercel AI SDK with retry logic, model fallbacks, cost controls, PostHog tracing, and support for multiple providers (OpenAI, Anthropic, Google, Bedrock, Groq, Ollama). This is an impressively engineered abstraction, but it is designed for a multi-provider cloud environment. PAAIR uses a single local model via Ollama's native REST API. Adopting this abstraction layer would add significant complexity for no benefit. However, studying its error handling patterns (quota exceeded, invalid keys, model-specific tool filtering) is worthwhile for understanding edge cases that PAAIR should handle when Ollama is unavailable or returns malformed output.

### 3.2 Reply Generation Module (`apps/web/utils/ai/reply/`)

The 16-file reply module includes sophisticated features: confidence scoring for draft replies, writing style learning/summarisation, reply memory (learning from past responses), and nudge generation. These are designed for a system that handles thousands of emails across many users. PAAIR's reply generation is much simpler: a single system prompt, a single model, no style learning (the fine-tuned model embodies Ricardo's style), and no confidence scoring (the escalation triage handles quality gating). The module is worth reading for prompt engineering patterns, but forking it would import more complexity than value.

### 3.3 Outlook Integration (`apps/web/app/api/outlook/`)

Inbox Zero's Outlook integration covers calendar OAuth, drive (OneDrive) access, account linking, webhook watching, and webhook processing. PAAIR needs only the calendar OAuth flow and the free/busy query. The full Outlook integration handles email reading, watching for new messages, and drive access, none of which PAAIR requires. The OAuth callback pattern is worth studying (particularly the token refresh handling), but PAAIR's Microsoft Graph integration is simple enough to implement directly against the Graph API documentation.

## 4. Components to Discard Entirely

The following Inbox Zero components have no applicability to PAAIR and should not be forked:

The **bulk unsubscriber**, **cold email blocker**, **email analytics/Tinybird integration**, **Slack/Telegram integrations**, **reply tracking**, **smart filing/Drive integration**, **payment processing (Stripe/LemonSqueezy)**, **user authentication and multi-tenancy**, **Prisma schema and migrations** (PAAIR uses SQLite), **Sanity CMS integration**, **frontend React components**, and **the entire Next.js application shell**. These collectively represent approximately 80-85% of the Inbox Zero codebase.

## 5. Recommended Fork Strategy

Given that only 15-20% of Inbox Zero's codebase is relevant and that the relevant components require moderate to significant adaptation, a full repository fork is inadvisable. Instead, the recommended approach is a selective extraction strategy:

First, clone the Inbox Zero repository locally as a reference. Do not fork it on GitHub, as maintaining a fork relationship with a rapidly evolving project (Inbox Zero has frequent commits) creates unnecessary merge burden.

Second, extract the following files into PAAIR's project structure, adapting them as standalone modules:

| Source File | Target in PAAIR | Adaptation |
|-------------|-----------------|------------|
| `utils/stringify-email.ts` | `paair/utils/format_email.ts` | Remap field names for Resend payload |
| `utils/ai/security.ts` | `paair/prompts/security.ts` | Use verbatim |
| `utils/ai/choose-rule/ai-choose-rule.ts` | `paair/utils/triage_email.ts` | Replace Vercel AI SDK with Ollama API calls; redefine rules as escalation triggers |
| `utils/ai/reply/reply-context-collector.ts` | `paair/utils/parse_thread.ts` | Strip database queries; focus on email chain parsing |
| `docker-compose.yml` | `paair/docker-compose.yml` | Replace services as described in Section 2.6 |
| `packages/resend/src/` | `paair/utils/resend_client.ts` | Strip React Email; add inbound retrieval |

Third, for the meeting briefs and reply generation patterns, study the source code but implement PAAIR's versions from scratch using the prompt templates and architectural patterns as inspiration rather than porting the code directly.

## 6. Licensing Considerations

Inbox Zero is licensed under the AGPL-3.0 licence. This has significant implications for a selective extraction strategy. Under AGPL-3.0, any code derived from Inbox Zero must also be distributed under AGPL-3.0 if it is made available as a network service. Since PAAIR is a personal tool running locally (not offered as a service to others), the AGPL's network-use clause does not trigger. However, if Ricardo were ever to distribute PAAIR or offer it as a service, the AGPL-derived components would require the entire PAAIR codebase to be released under AGPL-3.0.

The practical recommendation is: for the security constants and the email stringification utility (which are small, generic, and would likely be independently written in a similar form), the copyright risk is negligible. For the more substantial components (rule selection architecture, context collector), it would be prudent to use them as reference implementations and rewrite PAAIR's versions from scratch, informed by the patterns but not copying code verbatim. This avoids any AGPL encumbrance entirely.

## 7. Summary of Estimated Effort

Extracting and adapting the recommended components represents approximately 12-18 hours of development work, compared to approximately 25-35 hours to build equivalent functionality from scratch. The primary savings come from the email stringification layer (a surprisingly fiddly problem with edge cases around quoted-printable encoding, nested forwarded messages, and attachment metadata extraction) and the rule selection prompting pattern (which has been iterated through production use and handles edge cases like case-insensitive rule matching and multi-rule scenarios that are easy to overlook in a greenfield implementation).
