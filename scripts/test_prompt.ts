/**
 * Test script: sends a test email through the Ollama model with the system prompt.
 * Dry run only; does NOT send via Resend or Telegram.
 *
 * Usage:
 *   npx tsx scripts/test_prompt.ts                          # default research query
 *   npx tsx scripts/test_prompt.ts meeting                  # meeting request test
 *   npx tsx scripts/test_prompt.ts welfare                  # welfare escalation test
 *   npx tsx scripts/test_prompt.ts custom "Your email text" # custom email text
 */
import { getConfig } from '../src/config.js';
import { buildSystemPrompt } from '../src/utils/build_prompt.js';
import { formatEmailForLLM, extractSenderName } from '../src/utils/format_email.js';
import { chatWithTools, loadToolDefinitions } from '../src/ollama/client.js';
import type { InboundEmail, OllamaMessage } from '../src/types.js';

const config = getConfig();

const TEST_EMAILS: Record<string, InboundEmail> = {
  research: {
    from: 'Dr Sarah Chen <s.chen@oxford.ac.uk>',
    to: 'assistant@paair.ricardotwumasi.com',
    subject: 'Follow-up on your psychosis employment paper',
    text: 'Hi Ricardo, I read your paper on employment outcomes in first-episode psychosis with great interest. Could you point me to any follow-up publications or related datasets? I am exploring a similar question in our Oxford cohort.',
    messageId: '<test-prompt-001@oxford.ac.uk>',
    date: new Date().toISOString(),
  },
  meeting: {
    from: 'Prof James Wright <j.wright@ucl.ac.uk>',
    to: 'assistant@paair.ricardotwumasi.com',
    subject: 'Catch up re: UKRI application',
    text: 'Hi Ricardo, would you have time for a call to discuss the UKRI grant application? I have some thoughts on the methodology section and would like to align before the deadline.',
    messageId: '<test-prompt-002@ucl.ac.uk>',
    date: new Date().toISOString(),
  },
  welfare: {
    from: 'Alex Thompson <alex.thompson@kcl.ac.uk>',
    to: 'assistant@paair.ricardotwumasi.com',
    subject: 'Need to talk',
    text: 'Hi Ricardo, I am one of your PhD students. I have been struggling quite a lot recently and I am not sure I can continue with the programme. Could we talk?',
    messageId: '<test-prompt-003@kcl.ac.uk>',
    date: new Date().toISOString(),
  },
};

// Parse CLI args
const scenario = process.argv[2] || 'research';
let email: InboundEmail;

if (scenario === 'custom') {
  const customText = process.argv[3];
  if (!customText) {
    console.error('Usage: npx tsx scripts/test_prompt.ts custom "Your email text here"');
    process.exit(1);
  }
  email = {
    from: 'Test User <test@example.ac.uk>',
    to: 'assistant@paair.ricardotwumasi.com',
    subject: 'Test email',
    text: customText,
    messageId: '<test-custom@example.ac.uk>',
    date: new Date().toISOString(),
  };
} else if (TEST_EMAILS[scenario]) {
  email = TEST_EMAILS[scenario];
} else {
  console.error(`Unknown scenario: ${scenario}`);
  console.error('Available: research, meeting, welfare, custom "text"');
  process.exit(1);
}

console.log('='.repeat(60));
console.log(`Scenario: ${scenario}`);
console.log(`From: ${email.from}`);
console.log(`Subject: ${email.subject}`);
console.log('='.repeat(60));
console.log();

// Build messages
const systemPrompt = buildSystemPrompt(config);
const emailContext = formatEmailForLLM(email);
const senderName = extractSenderName(email.from);
const senderAddress = email.from.match(/<([^>]+)>/)?.[1] || email.from;

const userMessage =
  `The following email has been received. The sender is ${senderName} (${senderAddress}). ` +
  `Today's date is ${new Date().toISOString().split('T')[0]}.\n\n` +
  emailContext;

const messages: OllamaMessage[] = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: userMessage },
];

const tools = loadToolDefinitions();

console.log('Sending to Ollama (this may take 30-60 seconds)...\n');

const startTime = Date.now();
const response = await chatWithTools(messages, tools);
const durationMs = Date.now() - startTime;

console.log(`Response received in ${(durationMs / 1000).toFixed(1)}s`);
console.log('-'.repeat(60));

if (response.message.tool_calls && response.message.tool_calls.length > 0) {
  for (const tc of response.message.tool_calls) {
    console.log(`\nTOOL CALL: ${tc.function.name}`);
    console.log('Arguments:', JSON.stringify(tc.function.arguments, null, 2));
  }

  // If there's also content, show it
  if (response.message.content) {
    console.log('\nAdditional content:');
    console.log(response.message.content);
  }
} else {
  console.log('\nRESPONSE (no tool call):');
  console.log(response.message.content);
}

console.log('\n' + '='.repeat(60));
console.log('Done. Edit prompts/system.md and re-run to test changes.');
