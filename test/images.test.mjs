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

test('a gif is filed as a png and a repeated name never overwrites the first picture', async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-images-'));
  const originalFetch = globalThis.fetch;
  const { spawnSync } = await import('node:child_process');
  const { FFMPEG } = await import('../scripts/pipeline.mjs');
  const gifFile = path.join(assetsDir, 'probe.gif');
  const made = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=8x8:d=0.1', '-frames:v', '1', gifFile], { encoding: 'utf8' });
  const gifBytes = made.status === 0 ? fs.readFileSync(gifFile) : null;
  fs.rmSync(gifFile, { force: true });
  try {
    globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    const first = await fetchImage({ url: 'https://example.org/a.png', name: 'logo', assetsDir });
    const second = await fetchImage({ url: 'https://example.org/b.png', name: 'logo', assetsDir });
    assert.equal(first.src, 'assets/logo.png');
    assert.equal(second.src, 'assets/logo-2.png');
    assert.equal(fs.readdirSync(assetsDir).filter((f) => f.endsWith('.source.json')).length, 2, 'both credits kept');
    if (gifBytes) {
      globalThis.fetch = async () => new Response(gifBytes, { headers: { 'content-type': 'image/gif' } });
      const gif = await fetchImage({ url: 'https://example.org/anim.gif', name: 'anim', assetsDir, ffmpeg: FFMPEG });
      assert.equal(gif.src, 'assets/anim.png', 'the plan takes png, jpg and webp only');
      assert.ok(!fs.existsSync(path.join(assetsDir, 'anim.gif')));
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});

test('audio is an asset too, so a licensed track reaches the credits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-assets-'));
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'bed.mp3'), 'not really an mp3');
  fs.writeFileSync(path.join(assetsDir, 'bed.mp3.source.json'), JSON.stringify({ author: 'xkeril', license: 'CC0 1.0', pageUrl: 'https://freesound.org/people/xkeril/sounds/609895' }));
  fs.writeFileSync(path.join(assetsDir, 'shot.png'), 'not really a png');
  try {
    const assets = listAssets(assetsDir);
    const audio = assets.find((a) => a.src.endsWith('bed.mp3'));
    assert.ok(audio, 'audio is listed');
    assert.equal(audio.kind, 'audio');
    assert.equal(audio.attribution.author, 'xkeril');
    assert.equal(assets.find((a) => a.src.endsWith('shot.png')).kind, 'image');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
