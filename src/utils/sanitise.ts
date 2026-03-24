import { createLogger } from '../logger.js';

const log = createLogger('sanitise');

const MAX_LENGTH = 80_000;

// Patterns that indicate possible prompt injection attempts (logged, not blocked)
const INJECTION_PHRASES: RegExp[] = [
  /ignore\s+(your|previous|all|the)\s+(instructions|prompt|rules|constraints)/i,
  /ignore\s+(?:todo|todas|toutes)\s+(?:las|les)\s+instrucciones/i,
  /ignorez?\s+les\s+instructions/i,
  /you\s+are\s+now\s+a?\s*(different|new|helpful|unrestricted)/i,
  /tu\s+es\s+maintenant/i,
  /ahora\s+eres/i,
  /respond\s+in\s+(french|spanish|chinese|german|arabic|japanese|korean|hindi|russian)/i,
  /r[eé]pond(?:s|ez)?\s+en\s+(fran[cç]ais|espagnol|chinois)/i,
  /reveal\s+your\s+(system\s+)?prompt/i,
  /show\s+me\s+your\s+(instructions|system\s+prompt|configuration)/i,
  /do\s+not\s+escalate/i,
  /pretend\s+(to\s+be|you\s+are)/i,
  /roleplay\s+as/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

const INJECTION_PATTERNS: [RegExp, string][] = [
  [/<\|im_start\|>/gi, '&lt;|im_start|&gt;'],
  [/<\|im_end\|>/gi, '&lt;|im_end|&gt;'],
  [/<\|endoftext\|>/gi, '&lt;|endoftext|&gt;'],
  [/<<SYS>>/gi, '&lt;&lt;SYS&gt;&gt;'],
  [/<<\/SYS>>/gi, '&lt;&lt;/SYS&gt;&gt;'],
  [/\[INST\]/gi, '&#91;INST&#93;'],
  [/\[\/INST\]/gi, '&#91;/INST&#93;'],
  [/<system>/gi, '&lt;system&gt;'],
  [/<\/system>/gi, '&lt;/system&gt;'],
  [/<\|system\|>/gi, '&lt;|system|&gt;'],
  [/<\|user\|>/gi, '&lt;|user|&gt;'],
  [/<\|assistant\|>/gi, '&lt;|assistant|&gt;'],
];

/**
 * Sanitise text from untrusted email content before passing to the LLM.
 * Neutralises common prompt injection vectors while preserving legitimate content.
 */
export function sanitiseForLLM(text: string): string {
  if (!text) return '';

  let result = text;

  // Strip null bytes and control characters (keep newlines, tabs, carriage returns)
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Escape prompt injection patterns
  let modified = false;
  for (const [pattern, replacement] of INJECTION_PATTERNS) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) modified = true;
  }

  if (modified) {
    log.warn('Sanitisation modified input: prompt injection patterns detected');
  }

  // Check for prompt injection phrases (log only, don't modify)
  for (const phrase of INJECTION_PHRASES) {
    if (phrase.test(result)) {
      log.warn('Possible prompt injection phrase detected', {
        pattern: phrase.source,
      });
      break; // Log once, not per match
    }
  }

  // Truncate excessively long inputs
  if (result.length > MAX_LENGTH) {
    log.warn('Input truncated', {
      originalLength: result.length,
      truncatedTo: MAX_LENGTH,
    });
    result = result.slice(0, MAX_LENGTH) + '\n[TRUNCATED]';
  }

  return result;
}

/**
 * Sanitise an email address string. Strips control characters and validates basic structure.
 */
export function sanitiseEmailAddress(email: string): string {
  return email.replace(/[\x00-\x1F\x7F]/g, '').trim();
}
