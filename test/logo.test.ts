import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

/** Width and height from a PNG's IHDR, after checking the signature. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  assert.ok(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('the logo: README shows it, and the dashboard uses the 512px square as its icon', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const img = /<img src="([^"]+)" alt="([^"]+)"/.exec(readme.split('\n# ')[0]!);
  assert.ok(img, 'the logo sits above the title');
  assert.ok(existsSync(join(repoRoot, img[1]!)), `${img[1]} exists`);
  const [w, h] = pngSize(join(repoRoot, 'docs', 'assets', 'logo-512.png'));
  assert.deepEqual([w, h], [512, 512]);
  const icon = join(repoRoot, 'web', 'public', 'icon-512.png');
  assert.deepEqual(pngSize(icon), [512, 512]);
  assert.ok(readFileSync(icon).equals(readFileSync(join(repoRoot, 'docs', 'assets', 'logo-512.png'))), 'the icon is the same 512px logo');
  // The repo's social preview (uploaded by hand in the repo settings): GitHub's 1280x640.
  assert.deepEqual(pngSize(join(repoRoot, 'docs', 'assets', 'social-preview.png')), [1280, 640]);
  const html = readFileSync(join(repoRoot, 'web', 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" type="image\/png" href="\/icon-512\.png" \/>/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon-512\.png" \/>/);
});
