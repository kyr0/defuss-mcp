/** VERIFIED: The client gate requires every supported client in each era on every server configuration. */
import { expect, it } from 'vitest';
import { CLIENT_ERAS, coverage, SERVERS, type Cell } from '../scripts/clients.ts';

it('accepts exactly the 112 documented cells and names every gap', () => {
  const cells: Cell[] = [];
  for (const [server, provider] of [...SERVERS, ['node', 'child'], ['bun', 'child']])
    for (const [client, eras] of Object.entries(CLIENT_ERAS))
      for (const era of eras)
        for (const mode of provider === 'child' ? ['stdio'] : ['auto', 'json', 'sse'])
          cells.push({ server, provider, client, era, mode });
  expect(coverage(cells)).toEqual({ expected: 112, missing: [], extra: [], duplicates: [] });
  const withoutGo = cells.filter((cell) => cell.client !== 'go');
  expect(coverage(withoutGo).missing).toHaveLength(14);
  expect(coverage([...cells, cells[0]!]).duplicates).toEqual(['node express node auto auto']);
  expect(coverage([...cells, { ...cells[0]!, client: 'rust' }]).extra).toEqual(['node express rust auto auto']);
  // The smoke run covers one HTTP server; a full run is extra there.
  expect(coverage(cells, true).extra).toHaveLength(112 - 24);
});
