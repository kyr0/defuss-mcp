// Static SVG bar charts and tables rendered at build time from the evidence
// snapshot. Why SVG over a chart library: the page then ships no chart code,
// the figures render without JavaScript, and the theme colours apply through
// CSS custom properties.
import { escapeHtml } from './highlight.ts';
import type { Evidence } from './data.ts';

export interface Bar {
  label: string;
  values: { series: number; value: number; text: string }[];
}

const SERVER_LABEL: Record<string, string> = {
  'node express': 'Node, Express',
  'bun express': 'Bun, Express',
  'bun bunway': 'Bun, bunway',
  'bun fetch': 'Bun, Fetch',
  'node child': 'Node, stdio',
  'bun child': 'Bun, stdio',
};
export const SERVERS = Object.keys(SERVER_LABEL);

/** Horizontal grouped bars as HTML, so labels keep the page's text size at every width. Each series has its own colour token. */
export function barChart(bars: Bar[], series: string[], caption: string): string {
  const max = Math.max(...bars.flatMap((bar) => bar.values.map((v) => v.value)));
  const groups = bars
    .map((bar) => {
      const rows = bar.values
        .map((v) => {
          const width = Math.max(0.5, (100 * v.value) / max).toFixed(1);
          return `<span class="mcp-bar-track"><span class="mcp-bar" data-series="${v.series}" style="--w:${width}%"></span><span class="mcp-bar-value">${escapeHtml(v.text)}</span></span>`;
        })
        .join('');
      return `<div class="mcp-bar-group" role="listitem"><span class="mcp-bar-label">${escapeHtml(bar.label)}</span><span class="mcp-bar-rows">${rows}</span></div>`;
    })
    .join('');
  const legend = series
    .map((name, i) => `<span class="mcp-legend-item"><span class="mcp-swatch" data-series="${i}"></span>${escapeHtml(name)}</span>`)
    .join('');
  const table = `<details class="mcp-chart-data"><summary>Data</summary><table class="table"><thead><tr class="table-row"><th class="table-head" scope="col">Case</th>${series
    .map((name) => `<th class="table-head mcp-num" scope="col">${escapeHtml(name)}</th>`)
    .join('')}</tr></thead><tbody>${bars
    .map((bar) => `<tr class="table-row"><th class="table-cell" scope="row">${escapeHtml(bar.label)}</th>${series
      .map((_, i) => `<td class="table-cell mcp-num">${escapeHtml(bar.values.find((v) => v.series === i)?.text ?? '')}</td>`)
      .join('')}</tr>`)
    .join('')}</tbody></table></details>`;
  return `<div class="mcp-legend" aria-hidden="true">${legend}</div><div class="mcp-bars" role="list" aria-label="${escapeHtml(caption)}">${groups}</div>${table}`;
}

const ms = (value: number) => value.toFixed(3) + ' ms';

export function latencyChart(evidence: Evidence): string {
  const bars: Bar[] = SERVERS.map((key) => {
    const [server, provider] = key.split(' ');
    const find = (method: string) => evidence.latency.find((r) => r.server === server && r.provider === provider && r.method === method);
    const values: Bar['values'] = [];
    const mcp = find('mcp-functions-auto'), rpc = find('rpc');
    if (mcp) values.push({ series: 0, value: mcp.p50Ms, text: ms(mcp.p50Ms) });
    if (rpc) values.push({ series: 1, value: rpc.p50Ms, text: ms(rpc.p50Ms) });
    if (!values.length) throw new Error('charts: no latency rows for ' + key);
    return { label: SERVER_LABEL[key]!, values };
  });
  return barChart(bars, ['MCP function call', 'defuss-rpc call'], 'Median latency per call by server and transport');
}

const THROUGHPUT_LABEL: Record<string, string> = {
  'mcp-functions-auto': 'Typed client, compact',
  'mcp-bytes': 'Binary tool, base64',
  'mcp-functions-dson': 'Typed client, DSON',
  'rpc-dson': 'defuss-rpc, DSON',
};
export function throughputChart(evidence: Evidence): string {
  const bars = Object.entries(THROUGHPUT_LABEL).map(([method, label]) => {
    const row = evidence.throughput.find((r) => r.method === method);
    if (!row) throw new Error('charts: no throughput row for ' + method);
    return { label, values: [{ series: 0, value: row.mibPerSecond, text: row.mibPerSecond.toFixed(0) + ' MiB/s' }] };
  });
  return barChart(bars, ['Payload MiB/s, eight in flight'], '64 KiB binary echo throughput by codec');
}

export function coldChart(evidence: Evidence): string {
  const bars = evidence.coldStart.map((row) => ({
    label: row.runtime === 'node' ? 'Node.js' : 'Bun',
    values: [
      { series: 0, value: row.currentMs, text: row.currentMs.toFixed(1) + ' ms' },
      { series: 1, value: row.baselineMs, text: row.baselineMs.toFixed(1) + ' ms' },
    ],
  }));
  return barChart(bars, ['v' + evidence.version, 'v' + evidence.coldStart[0]!.baselineVersion], 'Fresh process import time by runtime and release');
}

const CLIENT_LABEL: Record<string, string> = {
  node: 'TypeScript SDK on Node.js',
  bun: 'TypeScript SDK on Bun',
  python: 'Python SDK',
  go: 'Go SDK',
  'inspector-cli': 'MCP Inspector CLI',
};
/** Client rows by server columns; each cell counts the passed protocol eras and reply modes. */
export function clientTable(evidence: Evidence): string {
  const head = SERVERS.map((key) => `<th class="table-head mcp-num" scope="col">${escapeHtml(SERVER_LABEL[key]!)}</th>`).join('');
  const body = Object.entries(CLIENT_LABEL)
    .map(([client, label]) => {
      const cells = SERVERS.map((key) => {
        const [server, provider] = key.split(' ');
        const n = evidence.cells.filter((c) => c.client === client && c.server === server && c.provider === provider).length;
        if (!n) throw new Error(`charts: no client cells for ${client} on ${key}`);
        return `<td class="table-cell mcp-num"><span class="mcp-pass"><svg class="mcp-icon" aria-hidden="true"><use href="#i-check"/></svg>${n}</span></td>`;
      }).join('');
      return `<tr class="table-row"><th class="table-cell" scope="row">${escapeHtml(label)}</th>${cells}</tr>`;
    })
    .join('');
  return `<table class="table"><caption class="table-caption">Passed cells per client and server; HTTP cells cover the JSON, SSE and automatic reply modes in each protocol era.</caption><thead><tr class="table-row"><th class="table-head" scope="col">Client</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
