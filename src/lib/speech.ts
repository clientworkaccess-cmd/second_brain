/**
 * The words of speech, apart from the browser that hears and says them:
 * what of an answer is said aloud, where it can be cut into sentences while
 * it is still arriving, which of the browser's voices to use, and how
 * dictated words join what is already typed. Pure, no Node imports and no
 * DOM: the chat panel's voice hook (components/useVoice.ts) does the rest.
 *
 * The speech itself is the browser's own (the Web Speech API): nothing is
 * sent anywhere by the app, and there is no key. It is not Claude's voice;
 * Claude Code has none.
 */

/**
 * A reply without citations in its text. The agent is asked not to write
 * them; a wiki's own rules ask for them in pages, and habit carries over, so
 * what slips through is taken out here: `([[page]])` and `([[a]], [[b]])`
 * after a sentence, with or without "see" or "source:", and the footnote form
 * `^[raw/file.md]`. A page named in the sentence itself, "ask [[Mark Chen]]",
 * is not a citation and stays.
 */
export function withoutCitations(markdown: string): string {
  return markdown
    .replace(/[ \t]*\(\s*(?:(?:see|source|sources|from|per|cf\.?)\s*:?\s*)?\[\[[^\]]+\]\](?:\s*(?:[,;]|and)\s*\[\[[^\]]+\]\])*\s*\)/gi, '')
    .replace(/[ \t]*\^\[[^\]\n]*\]/g, '');
}

/** An answer, or a piece of one, as it is said: no markup, no SOURCES or WROTE line, no code. */
export function speakable(markdown: string): string {
  return (
    withoutCitations(markdown)
      // Lines the app shows as links, not as text.
      .replace(/^(SOURCES|WROTE):.*$/gm, '')
      // Code is not read out.
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      // [[Page|shown]] and [[Page]] by what the reader sees; [text](url) by its text; bare addresses not at all.
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      // Headings, quotes, list marks and table bars are layout.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, '')
      .replace(/\|/g, ', ')
      // Emphasis marks.
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')
      .replace(/[*_~]{2,}/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/(,\s*){2,}/g, ', ')
      .trim()
      .replace(/^,\s*/, '')
      .replace(/,$/, '')
  );
}

/**
 * The whole sentences in `text` from `from` on, and where the next one will
 * start. A sentence ends at . ! ? followed by a space, or at a line break;
 * while the answer is still arriving, what follows the last such end is left
 * for the next call. `final`: nothing more is coming, so the rest is one too.
 * An open code fence is waited out, so code is never said half-read.
 */
export function takeSentences(text: string, from: number, final: boolean): { sentences: string[]; next: number } {
  const sentences: string[] = [];
  let start = from;
  let i = from;
  let fenced = false;
  const push = (end: number): void => {
    const piece = text.slice(start, end).trim();
    if (piece) sentences.push(piece);
    start = end;
  };
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      fenced = !fenced;
      i += 3;
      continue;
    }
    const ch = text[i];
    if (!fenced) {
      if (ch === '\n') {
        push(i + 1);
      } else if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < text.length && /\s/.test(text[i + 1])) {
        // "e.g. this" and "3. item" are not ends: the mark has to follow a word of some length.
        const word = text.slice(start, i).match(/(\S+)$/)?.[1] ?? '';
        const abbreviation = ch === '.' && (/^(\d+|[A-Za-z]|e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|No|St)$/i.test(word) || word.length === 0);
        if (!abbreviation) push(i + 1);
      }
    }
    i++;
  }
  if (final && !fenced) push(text.length);
  else if (final) {
    // A fence that never closed: say what came before it.
    const open = text.lastIndexOf('```');
    if (open > start) push(open);
    start = text.length;
  }
  return { sentences, next: start };
}

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

/**
 * Which of the browser's voices to speak with: one for the reader's
 * language, and among those the ones that sound least like a machine. Edge's
 * "Natural" voices and Chrome's "Google" ones are far better than the plain
 * system voices, and say so in their names. -1 when there is none to choose.
 */
export function pickVoice(voices: readonly VoiceLike[], language: string): number {
  if (voices.length === 0) return -1;
  const want = language.toLowerCase();
  const base = want.split('-')[0];
  let best = -1;
  let bestScore = -Infinity;
  voices.forEach((voice, index) => {
    const lang = voice.lang.toLowerCase().replace('_', '-');
    let score = 0;
    if (lang === want) score += 40;
    else if (lang.split('-')[0] === base) score += 30;
    else if (lang.startsWith('en')) score += 5;
    if (/natural|neural/i.test(voice.name)) score += 20;
    else if (/\bonline\b/i.test(voice.name)) score += 14;
    else if (/^google\b/i.test(voice.name)) score += 12;
    else if (/\b(samantha|daniel|karen|moira|ava|allison|serena)\b/i.test(voice.name)) score += 8;
    if (/\b(compact|espeak|novelty)\b/i.test(voice.name)) score -= 10;
    if (voice.default) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** Dictated words joined to what is already in the box: one space between, and a capital to begin with. */
export function joinDictation(typed: string, spoken: string): string {
  const said = spoken.trim().replace(/\s+/g, ' ');
  if (!said) return typed;
  const before = typed.replace(/\s+$/, '');
  if (!before) return said.charAt(0).toUpperCase() + said.slice(1);
  const fresh = /[.!?]$/.test(before);
  return `${before} ${fresh ? said.charAt(0).toUpperCase() + said.slice(1) : said}`;
}

/** Why the browser would not listen, in words a reader can act on. */
export function listenProblem(error: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone is blocked for this site. Allow it in the address bar, then try again.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'This browser could not reach its speech service. Try Chrome, Edge or Safari.';
    case 'language-not-supported':
      return 'This browser cannot take dictation in your language.';
    default:
      return 'Dictation stopped. Try again.';
  }
}
