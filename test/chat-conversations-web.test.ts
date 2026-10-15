// Conversations and Projects in the Ask panel (web/src/components/Conversations.tsx), rendered on the server: the
// sidebar (conversations, Projects, shared badge), a thread with its sent files, and a Project's editor as its
// creator, an owner and someone it was shared with each see it.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

type Att = { id: string; name: string; kind: string; label: string; size: number; sha256: string };
type Project = { id: string; owner: string; name: string; instructions: string; files: Att[]; shared: boolean; createdAt: string; updatedAt: string };
let r: {
  renderConversationSidebar(c: { id: string; title: string; project: string | null; updatedAt: string; createdAt: string }[], p: { id: string; name: string; owner: string; shared: boolean; files: number; updatedAt: string; mine: boolean }[], view?: unknown): string;
  renderConversationThread(data: unknown): string;
  renderProjectEditor(p: Project | null, owner: boolean, me: string): string;
  mayConverse(role: string | undefined): boolean;
};

before(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'chat-conv-web-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as typeof r;
});

const at = new Date().toISOString();
const file: Att = { id: 'att-' + 'a'.repeat(32), name: 'notes.md', kind: 'text', label: 'text', size: 2048, sha256: 'b'.repeat(64) };
const project = (o: Partial<Project> = {}): Project => ({ id: 'p-0123456789abcdef', owner: 'example-owner', name: 'Pricing', instructions: 'be brief', files: [file], shared: false, createdAt: at, updatedAt: at, ...o });

test('only owners and writers get conversations', () => {
  assert.deepEqual(['owner', 'writer', 'viewer', undefined].map((x) => r.mayConverse(x)), [true, true, false, false]);
});

test('the sidebar: new, quick question, Projects (shared marked) and this person’s conversations with their Project', () => {
  const html = r.renderConversationSidebar(
    [{ id: 'c-0123456789abcdef', title: 'Why is 12 stuck?', project: 'p-0123456789abcdef', updatedAt: at, createdAt: at }],
    [{ id: 'p-0123456789abcdef', name: 'Pricing', owner: 'example-owner', shared: true, files: 1, updatedAt: at, mine: false }],
    { kind: 'conversation', id: 'c-0123456789abcdef' },
  );
  for (const id of ['conv-sidebar', 'conv-new', 'conv-quick', 'project-new', 'project-row', 'conv-row', 'conv-open', 'conv-rename', 'conv-delete']) assert.match(html, new RegExp(`data-testid="${id}"`), id);
  assert.match(html, /data-testid="conv-title">Why is 12 stuck\?</);
  assert.match(html, /data-testid="conv-project"> · Pricing</);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /shared/);
  assert.match(r.renderConversationSidebar([], []), /data-testid="conv-empty">None yet\. Each one is yours alone\./);
});

test('a thread: each question with its files, and the answer as the chat shows it', () => {
  const html = r.renderConversationThread({
    conversation: { id: 'c-0123456789abcdef', owner: 'alice', title: 'Totals', project: 'p-0123456789abcdef', createdAt: at, updatedAt: at },
    project: { id: 'p-0123456789abcdef', name: 'Pricing' },
    turns: [{ v: 1, id: '1-ab', at, by: 'alice', text: 'what rounds?', attachments: [file], state: 'answered', answer: { turn: 't', instance: 'shop', answer: 'the totals code', citations: [], unknownCitations: [], issueDraft: null, actions: [], refusedActions: [], readOnly: true, costUsd: 0.1 } }],
  });
  assert.match(html, /data-testid="conv-thread-title">Totals</);
  assert.match(html, /data-testid="conv-thread-project">Pricing</);
  assert.match(html, /data-testid="conv-question">what rounds\?/);
  assert.match(html, /data-testid="chat-sent-attachment"[\s\S]*notes\.md/);
  assert.match(html, /the totals code/);
});

test('a Project’s editor: its creator changes it and its files; only an owner gets the share box; someone it was shared with only reads it', () => {
  const asOwner = r.renderProjectEditor(project(), true, 'example-owner');
  for (const id of ['project-name', 'project-instructions', 'project-file', 'project-file-remove', 'project-shared', 'project-save', 'project-delete', 'project-new-conversation']) assert.match(asOwner, new RegExp(`data-testid="${id}"`), id);
  assert.match(asOwner, /data-slot="attach"/, 'its creator uploads files');
  assert.match(asOwner, /never override its own rules/);
  const asWriter = r.renderProjectEditor(project({ owner: 'alice' }), false, 'alice');
  assert.match(asWriter, /data-testid="project-save"/);
  assert.doesNotMatch(asWriter, /data-testid="project-shared"/, 'a writer never sees the share box');
  const sharedWithBob = r.renderProjectEditor(project({ shared: true }), false, 'bob');
  assert.match(sharedWithBob, /data-testid="project-read-only">Shared by @example-owner/);
  for (const id of ['project-save', 'project-delete', 'project-file-remove', 'project-shared']) assert.doesNotMatch(sharedWithBob, new RegExp(`data-testid="${id}"`), `${id} is the creator's only`);
  assert.doesNotMatch(sharedWithBob, /data-slot="attach"/, 'no uploads either');
  assert.match(sharedWithBob, /data-testid="project-new-conversation"/, 'but they start their own conversations in it');
  assert.match(sharedWithBob, /data-testid="project-name"[^>]*disabled|disabled[^>]*data-testid="project-name"/);
});
