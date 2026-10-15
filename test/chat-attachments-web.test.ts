// The chat's attachment UI (web/src/components/ChatAttachments.tsx), rendered on the server: the chips (name, size,
// remove), the secret warning with "Attach anyway", the paperclip only for the owners and writers, the drop hint,
// and what the browser checks before it uploads.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

type Pending = { key: string; name: string; size: number; state: 'uploading' | 'ready' | 'secret' | 'error'; kinds?: string[]; why?: string; scanned?: boolean };
type Limits = { maxFileMb: number; maxMessageMb: number; retentionDays: number; maxFiles: number; extensions: string[] };
let r: {
  renderAttachmentList(items: Pending[]): string;
  renderAttachButton(role: string | undefined, disabled?: boolean): string;
  renderDropHint(active: boolean): string;
  renderSentAttachments(items: { id: string; name: string; kind: string; label: string; size: number; sha256: string }[]): string;
  precheck(files: { name: string; size: number }[], have: { size: number }[], l: Limits | null): { name: string; why: string | null }[];
  filesOf(dt: { files: unknown } | null): unknown[];
  fmtSize(n: number): string;
  mayAttach(role: string | undefined): boolean;
  safeBlob(b: Blob): { blob: Blob; view: boolean };
  attachmentNameHeader(name: string): string;
};

before(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'chat-attach-web-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as typeof r;
});

test('a chip shows the file\'s name and size and a remove button; a refused one says why', () => {
  const html = r.renderAttachmentList([
    { key: 'a1', name: 'shot.png', size: 2048, state: 'ready' },
    { key: 'a2', name: 'notes.txt', size: 12, state: 'uploading' },
    { key: 'a3', name: 'm.xlsm', size: 10, state: 'error', why: 'macro-enabled Office files are refused: nothing attached may run' },
  ]);
  assert.equal((html.match(/data-testid="chat-attachment-chip"/g) ?? []).length, 3);
  assert.match(html, /data-testid="chat-attachment-name">shot\.png<[\s\S]*?data-testid="chat-attachment-size">2\.0 KB</);
  assert.equal((html.match(/data-testid="chat-attachment-remove"/g) ?? []).length, 3);
  assert.match(html, /aria-label="Remove shot\.png"/);
  assert.match(html, /data-state="uploading"[\s\S]*?uploading…/);
  assert.match(html, /data-testid="chat-attachment-error">macro-enabled Office files are refused/);
  assert.equal(r.renderAttachmentList([]), '', 'no chips, no list');
});

test('a file that looks like it holds a secret: the kinds (never the value) and an explicit "Attach anyway"', () => {
  const html = r.renderAttachmentList([{ key: 'a1', name: 'env.txt', size: 40, state: 'secret', kinds: ['GitHub token'], why: 'x' }]);
  assert.match(html, /data-testid="chat-attachment-secret"[\s\S]*?This file looks like it contains a secret: GitHub token\. It isn(&#x27;|')t attached\./);
  assert.match(html, /data-testid="chat-attachment-anyway"[^>]*>Attach anyway</);
  assert.doesNotMatch(r.renderAttachmentList([{ key: 'a1', name: 'ok.txt', size: 4, state: 'ready' }]), /chat-attachment-anyway/);
});

test('the paperclip is the owners\' and the writers\' only: a viewer never sees it', () => {
  for (const role of ['owner', 'writer']) {
    const html = r.renderAttachButton(role);
    assert.match(html, /data-testid="chat-attach"/, role);
    assert.match(html, /type="file"[^>]*multiple[^>]*accept="\.png,\.pdf"|accept="\.png,\.pdf"[^>]*type="file"/);
  }
  assert.equal(r.renderAttachButton('viewer'), '');
  assert.equal(r.renderAttachButton(undefined), '');
  assert.match(r.renderAttachButton('owner', true), /disabled=""/);
  assert.equal(r.mayAttach('writer'), true);
  assert.equal(r.mayAttach('viewer'), false);
});

test('drag and drop: the hint shows only while files are over the panel; a drop or paste takes only files', () => {
  assert.match(r.renderDropHint(true), /data-testid="chat-drop"[^>]*>Drop files to attach them</);
  assert.equal(r.renderDropHint(false), '');
  const f = { name: 'a.txt', size: 1 };
  assert.deepEqual(r.filesOf({ files: [f] }), [f]);
  assert.deepEqual(r.filesOf({ files: [] }), [], 'pasted text carries no files');
  assert.deepEqual(r.filesOf(null), []);
});

test('before uploading: types, macro files, the per-file and per-question caps and the count, said at once', () => {
  const l: Limits = { maxFileMb: 1, maxMessageMb: 2, retentionDays: 30, maxFiles: 3, extensions: ['png', 'txt'] };
  const MB = 1024 * 1024;
  const why = (files: { name: string; size: number }[], have: { size: number }[] = []) => r.precheck(files, have, l).map((x) => x.why);
  assert.deepEqual(why([{ name: 'a.png', size: 10 }]), [null]);
  assert.match(why([{ name: 'a.exe', size: 10 }])[0]!, /\.exe isn't a type/);
  assert.match(why([{ name: 'a.docm', size: 10 }])[0]!, /macro-enabled/);
  assert.match(why([{ name: 'a.png', size: 1.5 * MB }])[0]!, /1 MB limit per file/);
  assert.deepEqual(why([{ name: 'a.png', size: 0.9 * MB }, { name: 'b.png', size: 0.9 * MB }, { name: 'c.png', size: 0.9 * MB }]).map((x) => x && /per question/.test(x)), [null, null, true]);
  assert.match(why([{ name: 'd.txt', size: 1 }], [{ size: 1 }, { size: 1 }, { size: 1 }])[0]!, /at most 3 files/);
  assert.deepEqual(r.precheck([{ name: 'x.zzz', size: 1 }], [], null), [{ name: 'x.zzz', why: null }], 'without limits yet the server decides');
});

test('a sent question lists its attachments, each opened through the dashboard', () => {
  const html = r.renderSentAttachments([{ id: 'att-' + 'a'.repeat(32), name: 'shot.png', kind: 'image', label: 'PNG image', size: 3 * 1024 * 1024, sha256: 'x' }]);
  assert.match(html, /data-testid="chat-sent-attachment"[^>]*>[\s\S]*?shot\.png[\s\S]*?3\.0 MB/);
  assert.doesNotMatch(html, /href=/, 'no link carries it: it is fetched with the normal sign-in');
  assert.equal(r.fmtSize(512), '512 B');
});

test('opening a sent file: only a raster image opens in a tab; any other type, whatever the server said, downloads as bytes', async () => {
  // A blob: URL is the dashboard's own origin and keeps none of the server's sandbox or nosniff headers.
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG; x=1']) {
    const o = r.safeBlob(new Blob(['x'], { type }));
    assert.equal(o.view, true, type);
    assert.equal(o.blob.type, type.split(';')[0]!.toLowerCase());
  }
  for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/pdf', 'text/plain', '']) {
    const o = r.safeBlob(new Blob(['<script>alert(1)</script>'], { type }));
    assert.equal(o.view, false, `${type || '(none)'} never opens`);
    assert.equal(o.blob.type, 'application/octet-stream', `${type || '(none)'} becomes opaque bytes`);
    assert.equal(await o.blob.text(), '<script>alert(1)</script>', 'the bytes are kept as they were');
  }
});

test('the name header: the last 200 characters, whole code points, always encodable', () => {
  const long = '\u{1F600}'.repeat(250) + '.txt';
  const h = r.attachmentNameHeader(long);
  const back = decodeURIComponent(h);
  assert.equal(Array.from(back).length, 200);
  assert.ok(back.endsWith('.txt'), 'the extension stays');
  assert.ok(h.length <= 4096, 'fits the hub\'s header limit');
  assert.equal(r.attachmentNameHeader('a b.png'), 'a%20b.png');
});

test('an image, PDF or Office file is kept without a secret scan, and its chip says so', () => {
  const html = r.renderAttachmentList([
    { key: 'a1', name: 'shot.png', size: 10, state: 'ready', scanned: false },
    { key: 'a2', name: 'notes.txt', size: 10, state: 'ready' },
  ]);
  assert.equal((html.match(/data-testid="chat-attachment-unscanned"/g) ?? []).length, 1);
  assert.match(html, /shot\.png[\s\S]*?data-testid="chat-attachment-unscanned"[^>]*>Not scanned for secrets: the scan reads text files only\./);
});
