import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '../logger.js';
import { getConfig, getProjectRoot } from '../config.js';
import type { ResearchIndex, ResearchPaper, ResearchProfile } from '../types.js';

const log = createLogger('research');

let cachedIndex: ResearchIndex | null = null;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'shall', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me',
  'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
  'what', 'which', 'who', 'whom', 'where', 'when', 'why', 'how',
  'not', 'no', 'nor', 'if', 'then', 'than', 'so', 'as', 'up', 'out',
  'about', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'under', 'again', 'further', 'once', 'here',
  'there', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'only', 'own', 'same', 'just', 'also',
  'very', 'any', 'hi', 'dear', 'ricardo', 'thanks', 'thank', 'regards',
  'best', 'kind', 'please', 'would', 'like', 'know', 'work', 'paper',
  'research', 'study', 'interested', 'email', 'message',
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Load the research paper index from YAML.
 */
export function loadResearchIndex(): ResearchIndex | null {
  if (cachedIndex) return cachedIndex;

  const config = getConfig();
  const papersPath = path.resolve(getProjectRoot(), config.research.papers_path);

  if (!fs.existsSync(papersPath)) {
    log.warn('Research papers index not found', { path: papersPath });
    return null;
  }

  try {
    const raw = fs.readFileSync(papersPath, 'utf-8');
    const parsed = parseYaml(raw) as { profile: ResearchProfile; papers: ResearchPaper[] };

    cachedIndex = {
      profile: parsed.profile,
      papers: parsed.papers || [],
    };

    log.info('Research index loaded', { paperCount: cachedIndex.papers.length });
    return cachedIndex;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('Failed to load research index', { error: msg });
    return null;
  }
}

/**
 * Find papers relevant to the given email text using keyword matching.
 * Returns papers sorted by relevance score, limited to maxPapers.
 */
export function findRelevantPapers(
  emailText: string,
  index: ResearchIndex,
  maxPapers?: number,
): ResearchPaper[] {
  const config = getConfig();
  const max = maxPapers ?? config.research.max_context_papers;
  const minScore = config.research.min_relevance_score;

  const emailTokens = new Set(tokenise(emailText));

  const scored = index.papers.map((paper) => {
    let score = 0;

    // Topic keyword matches (+2 each)
    for (const topic of paper.topics) {
      const topicWords = tokenise(topic);
      for (const word of topicWords) {
        if (emailTokens.has(word)) {
          score += 2;
        }
      }
    }

    // Title word matches (+3 each, excluding stopwords)
    const titleWords = tokenise(paper.title);
    for (const word of titleWords) {
      if (emailTokens.has(word)) {
        score += 3;
      }
    }

    // Author name matches (+1)
    const authorWords = tokenise(paper.authors);
    for (const word of authorWords) {
      if (emailTokens.has(word)) {
        score += 1;
      }
    }

    // Journal name matches (+1)
    const journalWords = tokenise(paper.journal);
    for (const word of journalWords) {
      if (emailTokens.has(word)) {
        score += 1;
      }
    }

    return { paper, score };
  });

  return scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.paper);
}

/**
 * Format research context as XML for injection into the user message.
 */
export function formatResearchContext(
  papers: ResearchPaper[],
  profile: ResearchProfile,
): string {
  const profileSection = [
    '<researcher_profile>',
    `${profile.name}, ${profile.title}, ${profile.institution}.`,
    `Department: ${profile.department}`,
    `Research areas: ${profile.research_areas.join('; ')}`,
    profile.links.google_scholar ? `Google Scholar: ${profile.links.google_scholar}` : '',
    profile.links.orcid ? `ORCID: ${profile.links.orcid}` : '',
    profile.links.institutional ? `Profile: ${profile.links.institutional}` : '',
    '</researcher_profile>',
  ]
    .filter(Boolean)
    .join('\n');

  const paperSections = papers
    .map((p) => {
      const lines = [
        '<paper>',
        `<title>${p.title}</title>`,
        `<authors>${p.authors}</authors>`,
        `<year>${p.year}</year>`,
        `<journal>${p.journal}</journal>`,
      ];

      if (p.doi) lines.push(`<doi>${p.doi}</doi>`);
      const url = p.public_url || p.kcl_public_url;
      if (url && !url.includes('[none')) lines.push(`<url>${url}</url>`);

      if (p.abstract && !p.abstract.includes('[FILL IN')) {
        lines.push(`<abstract>${p.abstract}</abstract>`);
      }

      if (p.key_findings && p.key_findings.length > 0) {
        const findings = p.key_findings
          .filter((f) => !f.includes('[FILL IN'))
          .map((f) => `- ${f}`)
          .join('\n');
        if (findings) {
          lines.push(`<key_findings>\n${findings}\n</key_findings>`);
        }
      }

      lines.push('</paper>');
      return lines.join('\n');
    })
    .join('\n');

  return [
    '<research_context>',
    profileSection,
    '<relevant_papers>',
    paperSections,
    '</relevant_papers>',
    '</research_context>',
  ].join('\n');
}

/**
 * Get relevant research context for an email, ready to inject into the user message.
 * Returns null if no relevant papers are found or if the index is not available.
 */
export function getRelevantResearchContext(emailText: string): string | null {
  const index = loadResearchIndex();
  if (!index) return null;

  const papers = findRelevantPapers(emailText, index);
  if (papers.length === 0) {
    // Still include the profile even if no specific papers match
    return formatResearchContext([], index.profile);
  }

  log.info('Research context prepared', {
    matchedPapers: papers.length,
    titles: papers.map((p) => p.title.slice(0, 50)),
  });

  return formatResearchContext(papers, index.profile);
}
