// llms.txt from a template: {{snippet:id}} inserts a code example as a fenced
// block, {{name}} a slot. An unknown snippet or slot fails the build.
import type { Snippet } from './highlight.ts';

const FENCE: Record<Snippet['lang'], string> = { typescript: 'ts', shellscript: 'sh', json: 'json' };

export function llmsText(template: string, snippets: Readonly<Record<string, Snippet>>, slots: Readonly<Record<string, string>>): string {
  const out = template
    .replace(/\{\{snippet:([\w-]+)\}\}/g, (_match, id: string) => {
      const snippet = snippets[id];
      if (!snippet) throw new Error(`llms: no snippet "${id}"`);
      return '```' + FENCE[snippet.lang] + '\n' + snippet.code + '\n```';
    })
    .replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = slots[name];
      if (value === undefined) throw new Error(`llms: no slot "${name}"`);
      return value;
    });
  return out.endsWith('\n') ? out : out + '\n';
}
