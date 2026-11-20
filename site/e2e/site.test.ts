// The built site in three engines: every view renders from docs/, the live demo
// runs the published package in the page, and no request leaves the local server.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import { serve } from './serve.ts';

const OUTPUT = new URL('../../output/', import.meta.url);
const engines = { chromium, firefox, webkit };
const results: { engine: string; test: string; ms: number }[] = [];
let server: Server;
let url: string;

beforeAll(async () => {
  ({ server, url } = await serve());
});
afterAll(() => {
  server.close();
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(new URL('site-e2e.json', OUTPUT), JSON.stringify({ finishedUtc: new Date().toISOString(), results }, null, 2));
});

/** Collect page errors, console errors and any request outside the local server. A not-found page may report its own 404. */
function watch(page: Page, notFound?: string): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push('page error: ' + error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (notFound && message.location().url === notFound && message.text().includes('404')) return;
    problems.push('console error: ' + message.text());
  });
  page.on('request', (request) => {
    const target = request.url();
    if (!target.startsWith(url) && !target.startsWith('data:') && !target.startsWith('blob:'))
      problems.push('external request: ' + target);
  });
  return problems;
}
async function timed(engine: string, name: string, run: () => Promise<void>) {
  const started = performance.now();
  await run();
  results.push({ engine, test: name, ms: Math.round(performance.now() - started) });
}
const text = (page: Page, selector: string) => page.locator(selector).innerText();

for (const [engine, type] of Object.entries(engines)) {
  describe(engine, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await type.launch();
    });
    afterAll(async () => {
      await browser.close();
    });

    test('renders the home page and runs the demo against the published build', async () => {
      await timed(engine, 'home and demo', async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const problems = watch(page);
        const response = await page.goto(url + '/');
        expect(response?.status()).toBe(200);
        expect(await page.title()).toBe('defuss-mcp: TypeScript functions as MCP tools');
        expect(await page.content()).not.toContain('{{');
        for (const id of ['how', 'demo', 'clients', 'performance', 'install', 'api'])
          expect(await page.locator('#' + id).isVisible()).toBe(true);
        expect(await page.locator('.mcp-bars').count()).toBe(3);
        expect(await page.locator('.mcp-matrix tbody tr').count()).toBe(5);
        expect(await page.locator('.mcp-code pre').count()).toBeGreaterThan(40);
        const portrait = page.locator('.mcp-author img');
        await portrait.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => (document.querySelector('.mcp-author img') as HTMLImageElement | null)?.naturalWidth === 400);
        expect(await page.locator('.mcp-author-name').innerText()).toBe('Aron Homberg');

        await page.click('.mcp-install .toggle[value="pnpm"]');
        expect(await page.locator('[data-pm="pnpm"]').isVisible()).toBe(true);
        expect(await page.locator('[data-pm="bun"]').isVisible()).toBe(false);

        await page.locator('#demo').scrollIntoViewIfNeeded();
        await page.waitForSelector('[data-demo][data-state="ready"]', { timeout: 30_000 });
        expect(await page.locator('[data-tool-list] li').count()).toBe(4);
        await page.click('[data-call]');
        await page.waitForFunction(() => document.querySelector('[data-call-output]')?.textContent?.includes('"value": 7'));
        await page.click('.mcp-tool[value="schedule"]');
        await page.fill('[data-args]', '{"title":"Review","date":"tomorrow"}');
        await page.click('[data-call]');
        await page.waitForFunction(() => document.querySelector('[data-call-output]')?.textContent?.includes('INVALID_ARGUMENTS'));
        expect(await text(page, '[data-call-output]')).toContain('"/date"');

        await page.click('#tab-repair');
        await page.click('[data-repair-send]');
        await page.waitForFunction(() => document.querySelectorAll('[data-transcript] li').length === 2);
        expect(await text(page, '[data-transcript]')).toContain('"/b"');
        await page.click('[data-repair-fix]');
        await page.waitForFunction(() => document.querySelectorAll('[data-transcript] li').length === 4);
        expect(await text(page, '[data-transcript]')).toContain('BAY=');

        await page.click('#tab-typed');
        await page.click('[data-typed]');
        await page.waitForFunction(() => document.querySelector('[data-typed-output]')?.textContent?.includes('Map('));
        const typed = await text(page, '[data-typed-output]');
        expect(typed).toContain('5 : number');
        expect(typed).toContain('Uint8Array(2) [4, 6]');
        expect(typed).toContain('Map(2) { "mcp" => 2, "dson" => 1 }');
        expect(await page.locator('[data-wire] tr').count()).toBeGreaterThan(5);

        const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
        await page.click('.swap');
        expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(!dark);
        expect(problems).toEqual([]);
        await page.close();
      });
    }, 60_000);

    test('fits a phone-width viewport without horizontal overflow', async () => {
      await timed(engine, 'phone width', async () => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const problems = watch(page);
        await page.goto(url + '/');
        await page.locator('#demo').scrollIntoViewIfNeeded();
        await page.waitForSelector('[data-demo][data-state="ready"]', { timeout: 30_000 });
        // Code windows and tables scroll inside their own box; everything else must fit the viewport.
        const wide = await page.evaluate(() =>
          [...document.querySelectorAll('main *, header *, footer *')]
            .filter((el) => !el.closest('.mockup-code, .table-container, .tab-list, .parallax-layer, pre, dialog'))
            .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
            .map((el) => el.tagName.toLowerCase() + '.' + String(el.getAttribute('class') ?? '')),
        );
        expect(wide).toEqual([]);
        expect(problems).toEqual([]);
        await page.close();
      });
    }, 60_000);

    test('serves the not-found view for unknown paths', async () => {
      await timed(engine, 'not found', async () => {
        const page = await browser.newPage();
        const problems = watch(page, url + '/no/such/page');
        const response = await page.goto(url + '/no/such/page');
        expect(response?.status()).toBe(404);
        expect(await text(page, '#missing-title')).toBe('This page does not exist');
        expect(await page.locator('[data-view="home"]').isVisible()).toBe(false);
        const font = await page.evaluate(() => getComputedStyle(document.querySelector('#missing-title')!).fontFamily);
        expect(font).toContain('Space Grotesk');
        await page.click('.mk-empty-state-actions a');
        await page.waitForURL(url + '/');
        expect(await page.locator('#demo').isVisible()).toBe(true);
        expect(problems).toEqual([]);
        await page.close();
      });
    }, 30_000);
  });
}

test('publishes llms.txt with every slot and snippet filled', async () => {
  const response = await fetch(url + '/llms.txt');
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body.startsWith('# defuss-mcp\n')).toBe(true);
  expect(body).not.toContain('{{');
  expect(body).toContain('getMcpClient<typeof api>(sdk)');
});
