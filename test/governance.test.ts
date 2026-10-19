// Governance mode (#704), slice 1: which PRs the engine didn't open it governs (src/governance.ts), and the token
// that alone says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { governedPr, GovernedPr, governs, isGoverned, type GovernanceSource, type LabelEvent, type PrFacts } from '../src/governance.js';

const scope = { repo: 'acme/app', defaultBranch: 'main' };
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const none: GovernanceSource = { authors: [], label: null, all: false };
const all: GovernanceSource = { authors: [], label: null, all: true };
const byAuthor: GovernanceSource = { authors: ['Agent-One', 'renovate[bot]'], label: null, all: false };
const byLabel: GovernanceSource = { authors: [], label: 'governed', all: false };

const pr = (o: Partial<PrFacts> = {}): PrFacts => ({ number: 7, head: HEAD, baseRepo: 'acme/app', base: 'main', headRepo: 'acme/app', author: 'agent-one', labels: [], labelEvents: [], ...o });
const labeled = (actor: string, role: LabelEvent['role'], label = 'governed'): LabelEvent => ({ action: 'labeled', label, actor, role });
const unlabeled = (actor: string, role: LabelEvent['role'], label = 'governed'): LabelEvent => ({ action: 'unlabeled', label, actor, role });

const tokenOf = (source: GovernanceSource | null, facts: PrFacts) => governedPr(source, scope, facts).token;
const why = (source: GovernanceSource | null, facts: PrFacts) => governedPr(source, scope, facts).why ?? '';

test('off (no source) governs nothing, whatever the PR', () => {
  assert.equal(tokenOf(null, pr()), null);
  assert.match(why(null, pr()), /governance is off/);
});

test('the defaults govern nothing: no authors, no label, not all', () => {
  assert.equal(tokenOf(none, pr()), null);
  assert.match(why(none, pr()), /no source/);
});

test('authors: a listed login (any case, bots included) is governed; anyone else is not', () => {
  const t = tokenOf(byAuthor, pr());
  assert.ok(t);
  assert.equal(t.via, 'authors');
  assert.ok(tokenOf(byAuthor, pr({ author: 'AGENT-ONE' })));
  assert.ok(tokenOf(byAuthor, pr({ author: 'renovate[bot]' })));
  assert.equal(tokenOf(byAuthor, pr({ author: 'agent-two' })), null);
  assert.equal(tokenOf(byAuthor, pr({ author: 'renovate' })), null, 'a bot login is matched whole, never without its [bot]');
  assert.equal(tokenOf(byAuthor, pr({ author: 'agent-one-x' })), null, 'never a prefix');
});

test('all: every same-repo PR into the default branch', () => {
  const t = tokenOf(all, pr({ author: 'someone' }));
  assert.ok(t);
  assert.equal(t.via, 'all');
});

test('a PR from a fork is never governed, whatever is listed', () => {
  for (const source of [all, byAuthor, byLabel]) {
    const facts = pr({ headRepo: 'stranger/app', labels: ['governed'], labelEvents: [labeled('lead', 'owner')] });
    assert.equal(tokenOf(source, facts), null);
    assert.match(why(source, facts), /fork/);
    // A head repo GitHub no longer has (a deleted fork) is a fork too.
    assert.equal(tokenOf(source, pr({ headRepo: null, labels: ['governed'], labelEvents: [labeled('lead', 'owner')] })), null);
  }
  // The same repo in another case is the same repo.
  assert.ok(tokenOf(all, pr({ headRepo: 'ACME/App' })));
});

test('a PR whose author can not be resolved is never governed', () => {
  for (const author of ['', 'ghost', 'Ghost', 'not a login', '-leading-dash', `a${'b'.repeat(39)}`]) {
    assert.equal(tokenOf(all, pr({ author })), null, author);
    assert.match(why(all, pr({ author })), /author/);
  }
  // An unresolvable entry in the list matches nothing.
  assert.equal(tokenOf({ authors: [''], label: null, all: false }, pr({ author: '' })), null);
});

test("only PRs into this repo's default branch", () => {
  assert.equal(tokenOf(all, pr({ base: 'release' })), null);
  assert.match(why(all, pr({ base: 'release' })), /default branch/);
  assert.equal(tokenOf(all, pr({ baseRepo: 'acme/other', headRepo: 'acme/other' })), null);
});

test('a PR with no exact head or number is never governed (nothing to pin)', () => {
  for (const head of ['', 'abc', 'A'.repeat(40), `${HEAD}0`, 'main']) assert.equal(tokenOf(all, pr({ head })), null, head);
  assert.ok(tokenOf(all, pr({ head: 'c'.repeat(64) })), 'a SHA-256 repo head pins too');
  for (const number of [0, -1, 1.5, Number.NaN]) assert.equal(tokenOf(all, pr({ number })), null, String(number));
});

test('label: counted only when an owner or writer applied it last and it is still on the PR', () => {
  assert.equal(tokenOf(byLabel, pr({ labels: ['governed'], labelEvents: [labeled('lead', 'owner')] }))?.via, 'label');
  assert.ok(tokenOf(byLabel, pr({ labels: ['Governed'], labelEvents: [labeled('dev', 'writer', 'GOVERNED')] })), 'labels match in any case, as GitHub names them');
  // Applied by a viewer, or an account with no role (a bot, an unmapped login): not governed.
  assert.equal(tokenOf(byLabel, pr({ labels: ['governed'], labelEvents: [labeled('watcher', 'viewer')] })), null);
  assert.equal(tokenOf(byLabel, pr({ labels: ['governed'], labelEvents: [labeled('some-bot[bot]', null)] })), null);
  // A writer applied it, then a viewer took it off and put it back: the viewer's application is the one that counts.
  assert.equal(tokenOf(byLabel, pr({ labels: ['governed'], labelEvents: [labeled('dev', 'writer'), unlabeled('watcher', 'viewer'), labeled('watcher', 'viewer')] })), null);
  // Removed since: not on the PR.
  assert.equal(tokenOf(byLabel, pr({ labels: [], labelEvents: [labeled('dev', 'writer'), unlabeled('dev', 'writer')] })), null);
  // On the PR, but the read timeline has no application of it (cut short): not governed.
  assert.equal(tokenOf(byLabel, pr({ labels: ['governed'], labelEvents: [] })), null);
  // The timeline says applied, but the PR no longer carries it: not governed.
  assert.equal(tokenOf(byLabel, pr({ labels: [], labelEvents: [labeled('lead', 'owner')] })), null);
  // Another label applied by an owner says nothing.
  assert.equal(tokenOf(byLabel, pr({ labels: ['governed', 'other'], labelEvents: [labeled('watcher', 'viewer'), labeled('lead', 'owner', 'other')] })), null);
  // A label the source doesn't name governs nothing.
  assert.equal(tokenOf(byAuthor, pr({ author: 'stranger', labels: ['governed'], labelEvents: [labeled('lead', 'owner')] })), null);
});

test('the token: frozen, pinned to its PR and head', () => {
  const t = tokenOf(all, pr())!;
  assert.ok(isGoverned(t));
  assert.ok(Object.isFrozen(t));
  assert.throws(() => {
    (t as { number: number }).number = 8;
  }, TypeError);
  assert.throws(() => {
    (t as { head: string }).head = OTHER_HEAD;
  }, TypeError);
  assert.ok(governs(t, 7, HEAD));
  assert.equal(governs(t, 8, HEAD), false, 'another PR');
  assert.equal(governs(t, 7, OTHER_HEAD), false, 'a head that moved');
  assert.equal(governs(null, 7, HEAD), false);
});

test('a token is made only by the matcher: no forgery passes', () => {
  const real = tokenOf(all, pr())!;
  assert.throws(() => new GovernedPr(Symbol('mint'), 7, HEAD, 'all'), /only by governedPr/);
  assert.throws(() => Reflect.construct(GovernedPr, [Symbol.for('mint'), 7, HEAD, 'all']), /only by governedPr/);
  class Sub extends GovernedPr {
    constructor() {
      super(Symbol('mint'), 7, HEAD, 'all');
    }
  }
  assert.throws(() => new Sub(), /only by governedPr/);
  const forgeries: [string, unknown][] = [
    ['structural copy', { ...real }],
    ['same fields by hand', { number: 7, head: HEAD, via: 'all' }],
    ['Object.create on the prototype', Object.assign(Object.create(GovernedPr.prototype) as object, { number: 7, head: HEAD, via: 'all' })],
    ['prototype swapped in', Object.setPrototypeOf({ number: 7, head: HEAD, via: 'all' }, GovernedPr.prototype)],
    ['JSON round trip', JSON.parse(JSON.stringify(real))],
    ['structuredClone', structuredClone(real)],
    ['a Proxy of a real one', new Proxy(real, {})],
    ['Object.create over a real one', Object.create(real)],
  ];
  for (const [name, f] of forgeries) {
    assert.equal(f instanceof GovernedPr && f === real, false, name);
    assert.equal(isGoverned(f), false, name);
    assert.equal(governs(f, 7, HEAD), false, name);
  }
});

test('property: over every combination of facts, governed implies same repo, default branch, a resolved author and a source that names it', () => {
  const sources: (GovernanceSource | null)[] = [null, none, all, byAuthor, byLabel, { authors: ['agent-one'], label: 'governed', all: true }];
  const authors = ['agent-one', 'renovate[bot]', 'stranger', '', 'ghost'];
  const headRepos = ['acme/app', 'stranger/app', null];
  const bases = ['main', 'release'];
  const labelSets: [string[], LabelEvent[]][] = [
    [[], []],
    [['governed'], []],
    [['governed'], [labeled('lead', 'owner')]],
    [['governed'], [labeled('watcher', 'viewer')]],
    [['governed'], [labeled('dev', 'writer'), labeled('x[bot]', null)]],
    [[], [labeled('dev', 'writer')]],
  ];
  let checked = 0;
  let governed = 0;
  for (const source of sources)
    for (const author of authors)
      for (const headRepo of headRepos)
        for (const base of bases)
          for (const [labels, labelEvents] of labelSets) {
            const facts = pr({ author, headRepo, base, labels, labelEvents });
            const r = governedPr(source, scope, facts);
            checked++;
            assert.equal(r.token === null, r.why !== null, 'exactly one of token and why');
            if (!r.token) continue;
            governed++;
            assert.ok(source, 'off governs nothing');
            assert.equal(headRepo, 'acme/app', 'never a fork');
            assert.equal(base, 'main', 'only the default branch');
            assert.ok(author && author !== 'ghost', 'never an unresolved author');
            const named = (source.all && r.token.via === 'all') || (source.authors.some((a) => a.toLowerCase() === author.toLowerCase()) && r.token.via === 'authors') || (source.label !== null && r.token.via === 'label' && labels.includes('governed') && ['owner', 'writer'].includes(labelEvents.at(-1)?.role ?? ''));
            assert.ok(named, `governed via ${r.token.via} by a source that names it`);
            assert.ok(governs(r.token, facts.number, facts.head));
          }
  assert.equal(checked, sources.length * authors.length * headRepos.length * bases.length * labelSets.length);
  assert.ok(governed > 0, 'the property is not vacuous');
});
