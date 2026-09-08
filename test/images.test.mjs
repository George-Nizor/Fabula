import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchImage, listAssets } from '../scripts/images.mjs';

test('downloaded images retain source credits without breaking older assets', async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-images-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  try {
    const attribution = { pageUrl: 'https://example.org/photo', author: 'Photographer', license: 'CC BY 4.0' };
    const result = await fetchImage({ url: 'https://example.org/photo.png', name: 'test', attribution, assetsDir });
    assert.equal(result.attribution.source, 'https://example.org/photo.png');
    assert.equal(listAssets(assetsDir)[0].attribution.license, 'CC BY 4.0');
    assert.equal(listAssets(assetsDir)[0].attribution.pageUrl, attribution.pageUrl);
    fs.writeFileSync(path.join(assetsDir, 'legacy.png'), 'image');
    assert.equal(listAssets(assetsDir).find(a => a.src.endsWith('legacy.png')).attribution, null);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});
