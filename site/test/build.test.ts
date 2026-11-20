// The build-time renderers on real inputs: snippets, slots, views and llms.txt.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { snippets } from '../src/snippets.ts';
import { fillSnippets } from '../build/highlight.ts';
import { llmsText } from '../build/llms.ts';
import { fillSlots, GENERATED, renderView } from '../build/pages.ts';

describe('page renderers', () => {
  test('highlights a snippet into mockup-code lines and rejects unknown ids', async () => {
    const html = await fillSnippets('<div class="mockup-code" data-snippet="install-bun"></div>', snippets);
    expect(html).toContain('<pre data-prefix="$"><code>');
    expect(html).toContain('--shiki-dark');
    await expect(fillSnippets('<div class="mockup-code" data-snippet="nope"></div>', snippets)).rejects.toThrow(/nope/);
    await expect(fillSnippets('<div data-snippet="hero" class="mockup-code"></div>', snippets)).rejects.toThrow(/not filled/);
  });

  test('fills slots and fails on an unknown one', () => {
    expect(fillSlots('v{{version}}', { version: '1.2.3' })).toBe('v1.2.3');
    expect(() => fillSlots('{{missing}}', {})).toThrow(/missing/);
  });

  test('shows one view and gives the not-found page root-absolute URLs', () => {
    const source = '<!--site:head--><a href="./">home</a><link href="./assets/x.css"><div class="mcp-view" data-view="home" hidden></div><div class="mcp-view" data-view="missing" hidden></div>';
    const home = renderView(source, 'home');
    expect(home).toContain('<div class="mcp-view" data-view="home">');
    expect(home).toContain('data-view="missing" hidden');
    expect(home).toContain('href="./assets/x.css"');
    const missing = renderView(source, 'missing');
    expect(missing).toContain('href="/assets/x.css"');
    expect(missing).toContain('<a href="/">');
    expect(missing).toContain('noindex');
    expect(() => renderView(source + '{{x}}', 'home')).toThrow(/unfilled/);
  });

  test('renders the llms.txt template with code blocks from the page snippets', () => {
    const template = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
    const slots = { version: '9.9.9', cells: '112', origin: 'https://example.test', repo: 'https://example.test/repo' };
    const text = llmsText(template, snippets, slots);
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain('```ts\n' + snippets.typed.code + '\n```');
    expect(() => llmsText('{{snippet:nope}}', snippets, slots)).toThrow(/nope/);
    expect(() => llmsText('{{nope}}', snippets, slots)).toThrow(/nope/);
  });

  test('cleans only its own files in docs/, never the package pages', () => {
    expect(GENERATED.some((name) => name.endsWith('.md'))).toBe(false);
  });
});
