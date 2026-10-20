// The value page (web/src/pages/Value.tsx, #708): a viewer's page renders the refusal and no value panel; an owner's
// or a writer's view shows the counts, "no data" for an empty window, and the hours estimate with its formula and
// constants. Rendered to static markup from the page's own module, bundled with the project's vite.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_VALUE_CONSTANTS, valueReport, type ValueEvent } from '../src/value-report.js';
import { repoRoot } from './helpers.js';

interface Render {
  renderPage(state: unknown): string;
  renderView(r: unknown): string;
}
let r: Render;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'value-web-'));
  const entry = join(dir, 'entry.ts');
  const abs = (...p: string[]) => JSON.stringify(join(repoRoot, ...p));
  writeFileSync(
    entry,
    [
      `import { renderToStaticMarkup } from ${abs('node_modules', 'react-dom', 'server.js')};`,
      `import { createElement } from ${abs('node_modules', 'react', 'index.js')};`,
      `import { ValuePage, ValueReportView } from ${abs('web', 'src', 'pages', 'Value.tsx')};`,
      'export const renderPage = (state: any) => renderToStaticMarkup(createElement(ValuePage, { state, pulse: 0 }));',
      'export const renderView = (r: any) => renderToStaticMarkup(createElement(ValueReportView, { r }));',
    ].join('\n'),
  );
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = join(dir, 'out');
  await build({
    configFile: false,
    root: join(repoRoot, 'web'),
    logLevel: 'silent',
    plugins: [react()],
    ssr: { noExternal: true },
    build: { ssr: entry, outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'value.mjs' } } },
  });
  r = (await import(pathToFileURL(join(out, 'value.mjs')).href)) as Render;
});

const state = (role: string | undefined) => ({ brand: { name: 'x', cli: 'x' }, user: 'someone', role, project: { name: 'p', repo: 'o/p', landMode: 'pr' }, reports: [] });

test('a viewer\'s page (or one whose role is unknown) renders the refusal and no value panel', () => {
  for (const role of ['viewer', undefined]) {
    const html = r.renderPage(state(role));
    assert.match(html, /data-testid="page-value"/);
    assert.match(html, /data-testid="value-refused"/);
    assert.match(html, /owners and writers/);
    assert.doesNotMatch(html, /data-testid="value-panel"/, String(role));
  }
  for (const role of ['owner', 'writer']) assert.doesNotMatch(r.renderPage(state(role)), /value-refused/, role);
});

test('the view: counts, hold rate, "no data" when empty, and the hours estimate with its formula and constants', () => {
  const NOW = new Date('2026-10-13T12:00:00.000Z');
  const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const sha = (c: string) => c.repeat(40);
  const events: ValueEvent[] = [
    { ts: at(11), type: 'pr.stats', payload: { issue: 1, number: 1, head: sha('a'), additions: 100, deletions: 100, files: 1, comments: 0 } },
    { ts: at(10), type: 'merge.decided', payload: { issue: 1, number: 1, head: sha('a'), auto: true, reasons: [] } },
    { ts: at(9), type: 'merge.done', payload: { issue: 1, number: 1, head: sha('a'), sha: sha('b'), url: 'u', title: 't' } },
    { ts: at(10), type: 'merge.decided', payload: { issue: 2, number: 2, head: sha('c'), auto: false, reasons: ['high-risk: auth (src/auth.ts)'] } },
  ];
  const html = r.renderView(valueReport(events, { now: NOW, days: 30, constants: DEFAULT_VALUE_CONSTANTS }));
  assert.match(html, /data-testid="value-panel"/);
  assert.match(html, /data-testid="value-hold-rate".*50%/s);
  assert.match(html, /High risk/);
  assert.match(html, /min\(cap_min, base_min/);
  assert.match(html, /base_min = 10, per_100_lines_min = 5, cap_min = 60/);
  assert.match(html, /estimate/);
  const empty = r.renderView(valueReport([], { now: NOW, days: 30 }));
  assert.match(empty, /data-testid="value-hold-rate"[^]*?no data/);
  assert.doesNotMatch(empty, /NaN/);
});
