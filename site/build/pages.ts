// Vite plugin: one page source becomes index.html, 404.html, llms.txt,
// robots.txt and sitemap.xml in docs/. Code windows, charts, tables and every
// {{slot}} are filled at build time, so the page reads correctly before any
// script runs.
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { snippets } from '../src/snippets.ts';
import { clientTable, coldChart, latencyChart, throughputChart } from './charts.ts';
import { loadEvidence, type Evidence } from './data.ts';
import { fillSnippets } from './highlight.ts';
import { llmsText } from './llms.ts';

/** The published address of docs/ and the public repository. Change both when the site or the repository moves. */
export const ORIGIN = 'https://mcp.defuss.org';
export const REPO_URL = 'https://github.com/kyr0/defuss-mcp';
const OUT = fileURLToPath(new URL('../../docs/', import.meta.url));
/** Files this build owns in docs/. The Markdown pages there belong to the package. */
export const GENERATED = ['assets', 'index.html', '404.html', 'llms.txt', 'robots.txt', 'sitemap.xml', 'favicon.svg', 'aron-homberg.jpg'];

export const META = {
  title: 'defuss-mcp: TypeScript functions as MCP tools',
  description:
    'Register TypeScript functions as Model Context Protocol tools and serve them over stdio, Express, bunway or any Fetch handler, with typed clients, agent-readable corrections and binary payloads.',
};

export function slots(evidence: Evidence): Record<string, string> {
  return {
    version: evidence.version,
    cells: String(evidence.cells.length),
    ...evidence.host,
    shortSha: evidence.packageSha256.slice(0, 12),
    load: evidence.loadAverage[0]!.toFixed(1),
    baselineVersion: evidence.coldStart[0]!.baselineVersion,
    repo: REPO_URL,
    origin: ORIGIN,
  };
}

export function fillSlots(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`pages: no slot "${name}"`);
    return value;
  });
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function head(view: 'home' | 'missing'): string {
  const tags = [
    `<title>${view === 'home' ? META.title : 'Page not found: defuss-mcp'}</title>`,
    `<meta name="description" content="${escapeAttribute(META.description)}">`,
    `<meta property="og:title" content="${escapeAttribute(META.title)}">`,
    `<meta property="og:description" content="${escapeAttribute(META.description)}">`,
    '<meta property="og:type" content="website">',
  ];
  tags.push(view === 'home' ? `<link rel="canonical" href="${ORIGIN}/">` : '<meta name="robots" content="noindex">');
  return tags.join('\n  ');
}

/** Fill the build-time parts of the page that do not depend on the view. */
export async function renderSource(html: string, evidence: Evidence): Promise<string> {
  let out = await fillSnippets(html, snippets);
  const parts: Record<string, string> = {
    'chart:latency': latencyChart(evidence),
    'chart:throughput': throughputChart(evidence),
    'chart:cold': coldChart(evidence),
    'table:clients': clientTable(evidence),
  };
  out = out.replace(/<!--((?:chart|table):\w+)-->/g, (_match, id: string) => {
    const part = parts[id];
    if (!part) throw new Error(`pages: no part "${id}"`);
    return part;
  });
  return fillSlots(out, slots(evidence));
}

/** Show one view. 404.html takes root-absolute URLs, since the host serves it at any depth. */
export function renderView(source: string, view: 'home' | 'missing'): string {
  let html = source.replace('<!--site:head-->', head(view));
  html = html.replace(new RegExp(`(<div class="mcp-view" data-view="${view}")\\shidden`), '$1');
  if (view === 'missing') html = html.replace(/(\s(?:src|href)=")\.\//g, '$1/').replace(/(\shref=")\.\/?"/g, '$1/"');
  if (/\{\{|<!--site:|<!--(chart|table):/.test(html)) throw new Error(`pages: unfilled placeholder in the ${view} view`);
  return html;
}

export function pages(): Plugin {
  let source: string | undefined;
  let evidence: Evidence | undefined;
  return {
    name: 'defuss-mcp-site:pages',
    enforce: 'post',
    buildStart() {
      evidence = loadEvidence();
      if (this.meta.watchMode) return;
      for (const name of GENERATED) rmSync(OUT + name, { recursive: true, force: true });
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html) {
        source = await renderSource(html, (evidence ??= loadEvidence()));
        return renderView(source, 'home');
      },
    },
    generateBundle() {
      if (!source || !evidence) throw new Error('pages: index.html was not processed');
      this.emitFile({ type: 'asset', fileName: '404.html', source: renderView(source, 'missing') });
      const template = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: llmsText(template, snippets, slots(evidence)) });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n` });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${ORIGIN}/</loc></url>\n</urlset>\n`,
      });
    },
  };
}
