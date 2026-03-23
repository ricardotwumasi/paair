import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { OllamaMessage, OllamaTool, OllamaChatResponse } from '../types.js';
import { ollamaChatResponseSchema } from '../types.js';

const log = createLogger('ollama');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_PATH = path.join(__dirname, '..', '..', 'prompts', 'tool_definitions.json');

let cachedTools: OllamaTool[] | null = null;

/**
 * Load tool definitions from prompts/tool_definitions.json.
 */
export function loadToolDefinitions(): OllamaTool[] {
  if (!cachedTools) {
    const raw = fs.readFileSync(TOOLS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { tools: OllamaTool[] };
    cachedTools = parsed.tools;
    log.info('Tool definitions loaded', { count: cachedTools.length });
  }
  return cachedTools;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.ok) return response;

      if (response.status >= 500) {
        lastError = new Error(`Ollama returned ${response.status}: ${response.statusText}`);
        log.warn(`Ollama 5xx error, attempt ${attempt + 1}/${maxRetries}`, {
          status: response.status,
        });
      } else {
        // 4xx errors are not retried
        throw new Error(
          `Ollama returned ${response.status}: ${response.statusText} - ${await response.text()}`,
        );
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        // Network error (connection refused, etc.)
        lastError = error;
        log.warn(`Ollama connection error, attempt ${attempt + 1}/${maxRetries}`, {
          error: error.message,
        });
      } else if (lastError === null) {
        throw error;
      }
    }

    if (attempt < maxRetries - 1) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error('Ollama request failed after retries');
}

/**
 * Send a chat request to Ollama with optional tool calling support.
 * Uses non-streaming mode for simpler response parsing.
 */
export async function chatWithTools(
  messages: OllamaMessage[],
  tools?: OllamaTool[],
): Promise<OllamaChatResponse> {
  const config = getConfig();

  const body = {
    model: config.model.name,
    messages,
    stream: false,
    options: {
      temperature: config.model.temperature,
      num_predict: config.model.max_tokens,
    },
    ...(tools && tools.length > 0 ? { tools } : {}),
  };

  const url = `${config.model.endpoint}/api/chat`;

  log.info('Sending request to Ollama', {
    model: config.model.name,
    messageCount: messages.length,
    hasTools: Boolean(tools?.length),
  });

  const startTime = Date.now();

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  const durationMs = Date.now() - startTime;

  log.info('Ollama response received', {
    durationMs,
    hasToolCalls: Boolean(data?.message?.tool_calls?.length),
    evalCount: data?.eval_count,
  });

  const parsed = ollamaChatResponseSchema.parse(data);
  return parsed;
}
