// Build-time syntax highlighting for every code window. Shiki runs once in the
// build and writes coloured spans into mockup-code lines, so the page ships no
// highlighter.
import { createHighlighter, type Highlighter } from 'shiki';

/** Light and dark token colours in one span each; styles.css picks the page theme's. */
export const CODE_THEMES = { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' } as const;
export const CODE_LANGUAGES = ['typescript', 'shellscript', 'json'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export interface Snippet {
  readonly lang: CodeLanguage;
  readonly code: string;
  /** Prompt for every line (`$` for shell); omitted, the window numbers its lines. */
  readonly prefix?: string;
}

let highlighter: Promise<Highlighter> | undefined;
const shiki = (): Promise<Highlighter> =>
  (highlighter ??= createHighlighter({ themes: Object.values(CODE_THEMES), langs: [...CODE_LANGUAGES] }));

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The `<pre><code>` lines of one mockup-code window, one span per token with `--shiki-light` and `--shiki-dark`. */
export async function highlightLines(snippet: Snippet): Promise<string> {
  const { tokens } = (await shiki()).codeToTokens(snippet.code.replace(/\n$/, ''), {
    lang: snippet.lang,
    themes: CODE_THEMES,
    defaultColor: false,
  });
  return tokens
    .map((line) => {
      const code = line
        .map((token) => {
          const style = Object.entries(token.htmlStyle ?? {})
            .map(([name, value]) => `${name}:${value}`)
            .join(';');
          return `<span style="${style}">${escapeHtml(token.content)}</span>`;
        })
        .join('');
      const prefix = snippet.prefix === undefined ? '' : ` data-prefix="${snippet.prefix}"`;
      return `<pre${prefix}><code>${code}</code></pre>`;
    })
    .join('\n');
}

const PLACEHOLDER = /(<div class="mockup-code[^"]*"[^>]*\sdata-snippet="([^"]+)"[^>]*>)(<\/div>)/g;

/** Fill every empty `<div class="mockup-code …" data-snippet="id"></div>`; an unknown id or a missed placeholder throws. */
export async function fillSnippets(html: string, snippets: Readonly<Record<string, Snippet>>): Promise<string> {
  const ids = [...html.matchAll(PLACEHOLDER)].map((match) => match[2]!);
  const filled = await Promise.all(
    ids.map((id) => {
      const snippet = snippets[id];
      if (!snippet) throw new Error(`highlight: no snippet "${id}"`);
      return highlightLines(snippet);
    }),
  );
  let index = 0;
  const out = html.replace(PLACEHOLDER, (_match, open: string, _id: string, close: string) => open + filled[index++] + close);
  const missed = /<div[^>]*\sdata-snippet="([^"]+)"[^>]*>\s*<\/div>/.exec(out);
  if (missed) throw new Error(`highlight: snippet placeholder "${missed[1]}" was not filled`);
  return out;
}
