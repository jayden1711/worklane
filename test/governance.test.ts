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

const pr = (o: Partial<PrFacts> = {}): PrFacts => ({ number: 7, head: HEAD, baseRepo: 'acme/app', base: 'main', headRepo: 'acme/app', author: 'agent-one', authorType: 'User', labels: [], labelEvents: [], ...o });
const bot = (author: string): Partial<PrFacts> => ({ author, authorType: 'Bot' });
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
  assert.ok(tokenOf(byAuthor, pr(bot('renovate[bot]'))));
  assert.equal(tokenOf(byAuthor, pr({ author: 'agent-two' })), null);
  assert.equal(tokenOf(byAuthor, pr({ author: 'renovate' })), null, 'a bot login is matched whole, never without its [bot]');
  assert.equal(tokenOf(byAuthor, pr(bot('renovate'))), null, "a reader that dropped the suffix (GraphQL's author.login) never matches the listed bot");
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

test('repo names: validated as ASCII before they are compared; anything else is refused', () => {
  // WHY: the Kelvin sign (U+212A) lowercases to k: a non-ASCII fold would make acme/Kit match acme/kit.
  const kit = { repo: 'acme/kit', defaultBranch: 'main' };
  const kelvin = 'acme/Kit';
  assert.equal(governedPr(all, kit, pr({ baseRepo: kelvin, headRepo: kelvin })).token, null);
  assert.equal(governedPr(all, kit, pr({ baseRepo: 'acme/kit', headRepo: kelvin })).token, null);
  assert.equal(governedPr(all, kit, pr({ baseRepo: kelvin, headRepo: 'acme/kit' })).token, null);
  assert.equal(governedPr(all, { repo: kelvin, defaultBranch: 'main' }, pr({ baseRepo: 'acme/kit', headRepo: 'acme/kit' })).token, null);
  assert.ok(governedPr(all, kit, pr({ baseRepo: 'ACME/KIT', headRepo: 'Acme/Kit' })).token, 'ASCII case still folds');
  for (const bad of ['', 'acme', 'acme/app/x', '/app', 'acme/', 'acme app/app', 'acme/app\n']) {
    assert.equal(tokenOf(all, pr({ headRepo: bad })), null, `head repo ${JSON.stringify(bad)}`);
    assert.equal(tokenOf(all, pr({ baseRepo: bad })), null, `base repo ${JSON.stringify(bad)}`);
  }
});

test('a PR whose author can not be resolved is never governed', () => {
  for (const author of ['', 'ghost', 'Ghost', 'not a login', '-leading-dash', `a${'b'.repeat(39)}`]) {
    assert.equal(tokenOf(all, pr({ author })), null, author);
    assert.match(why(all, pr({ author })), /author/);
  }
  // An unresolvable entry in the list matches nothing.
  assert.equal(tokenOf({ authors: [''], label: null, all: false }, pr({ author: '' })), null);
});

test("the author is REST's user.login verbatim, with its user.type: a shape that doesn't fit is refused", () => {
  // REST: an App's login keeps [bot] and its type is Bot; Copilot is a Bot with no suffix; User claude and Bot
  // claude[bot] are different accounts.
  assert.ok(tokenOf(all, pr(bot('dependabot[bot]'))));
  assert.ok(tokenOf(all, pr(bot('Copilot'))), 'a Bot with no [bot] suffix');
  assert.equal(tokenOf(all, pr({ author: 'claude[bot]', authorType: 'User' })), null, 'a [bot] login that GitHub says is a User');
  for (const authorType of ['Organization', 'Mannequin', 'EnterpriseUserAccount', '', 'bot', 'user'] as unknown as PrFacts['authorType'][]) {
    assert.equal(tokenOf(all, pr({ authorType })), null, String(authorType));
    assert.match(why(all, pr({ authorType })), /author/);
  }
  const listed: GovernanceSource = { authors: ['claude'], label: null, all: false };
  assert.ok(tokenOf(listed, pr({ author: 'claude' })), 'the User claude, listed');
  assert.equal(tokenOf(listed, pr(bot('claude[bot]'))), null, 'the Bot claude[bot] is another account');
});

test("only PRs into this repo's default branch", () => {
  assert.equal(tokenOf(all, pr({ base: 'release' })), null);
  assert.match(why(all, pr({ base: 'release' })), /default branch/);
  assert.equal(tokenOf(all, pr({ base: 'Main' })), null, 'branch names are exact');
});

test('a PR into another repo is refused on its own, even from a branch of this one', () => {
  const facts = pr({ baseRepo: 'acme/other', headRepo: 'acme/app' });
  assert.equal(tokenOf(all, facts), null);
  assert.match(why(all, facts), /targets acme\/other/);
});

test('an empty or invalid branch name, on either side, is refused: never equal by being blank', () => {
  for (const b of ['', ' ', 'main ', '-main', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a/', '/a', 'a//b', 'a.lock', 'a.', 'a@{b', '@', 'maİn', 'main\n']) {
    assert.equal(governedPr(all, { repo: 'acme/app', defaultBranch: b }, pr({ base: b })).token, null, `both ${JSON.stringify(b)}`);
    assert.equal(tokenOf(all, pr({ base: b })), null, `base ${JSON.stringify(b)}`);
  }
  for (const b of ['release/1.2', 'feature_x', 'v2-dev']) assert.ok(governedPr(all, { repo: 'acme/app', defaultBranch: b }, pr({ base: b })).token, b);
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

test('the token: frozen, pinned to its repo, PR and head', () => {
  const t = tokenOf(all, pr())!;
  assert.ok(isGoverned(t));
  assert.ok(Object.isFrozen(t));
  assert.equal(t.repo, 'acme/app');
  for (const k of ['repo', 'number', 'head', 'via'] as const) {
    assert.throws(() => {
      (t as unknown as Record<string, unknown>)[k] = 'x';
    }, TypeError, k);
    assert.equal(Object.getOwnPropertyDescriptor(t, k)?.writable, false, k);
  }
  assert.ok(governs(t, 'acme/app', 7, HEAD));
  assert.ok(governs(t, 'ACME/App', 7, HEAD), 'repo names fold ASCII case');
  assert.equal(governs(t, 'acme/app', 8, HEAD), false, 'another PR');
  assert.equal(governs(t, 'acme/app', 7, OTHER_HEAD), false, 'a head that moved');
  assert.equal(governs(t, 'acme/other', 7, HEAD), false, 'the same number and head in another repo');
  assert.equal(governs(null, 'acme/app', 7, HEAD), false);
  const kit = governedPr(all, { repo: 'acme/kit', defaultBranch: 'main' }, pr({ baseRepo: 'acme/kit', headRepo: 'acme/kit' })).token!;
  assert.ok(governs(kit, 'acme/kit', 7, HEAD));
  assert.equal(governs(kit, 'acme/Kit', 7, HEAD), false, 'never a non-ASCII fold (the Kelvin sign)');
});

test('a token minted for one repo never governs another (forks and mirrors share heads)', () => {
  const other = { repo: 'acme/other', defaultBranch: 'main' };
  const t = governedPr(all, other, pr({ baseRepo: 'acme/other', headRepo: 'acme/other' })).token!;
  assert.ok(t);
  assert.equal(t.repo, 'acme/other');
  assert.ok(governs(t, 'acme/other', 7, HEAD));
  assert.equal(governs(t, 'acme/app', 7, HEAD), false);
});

test('a token is made only by the matcher: no forgery passes', () => {
  const real = tokenOf(all, pr())!;
  assert.throws(() => new GovernedPr(Symbol('mint'), 'acme/app', 7, HEAD, 'all'), /only by governedPr/);
  assert.throws(() => Reflect.construct(GovernedPr, [Symbol.for('mint'), 'acme/app', 7, HEAD, 'all']), /only by governedPr/);
  class Sub extends GovernedPr {
    constructor() {
      super(Symbol('mint'), 'acme/app', 7, HEAD, 'all');
    }
  }
  assert.throws(() => new Sub(), /only by governedPr/);
  const fields = () => ({ repo: 'acme/app', number: 7, head: HEAD, via: 'all' });
  const forgeries: [string, unknown][] = [
    ['structural copy', { ...real }],
    ['same fields by hand', fields()],
    ['Object.create on the prototype', Object.assign(Object.create(GovernedPr.prototype) as object, fields())],
    ['prototype swapped in', Object.setPrototypeOf(fields(), GovernedPr.prototype)],
    ['JSON round trip', JSON.parse(JSON.stringify(real))],
    ['structuredClone', structuredClone(real)],
    ['a Proxy of a real one', new Proxy(real, {})],
    ['Object.create over a real one', Object.create(real)],
  ];
  for (const [name, f] of forgeries) {
    assert.equal(f instanceof GovernedPr && f === real, false, name);
    assert.equal(isGoverned(f), false, name);
    assert.equal(governs(f, 'acme/app', 7, HEAD), false, name);
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
            const facts = pr({ author, authorType: author.endsWith('[bot]') ? 'Bot' : 'User', headRepo, base, labels, labelEvents });
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
            assert.ok(governs(r.token, scope.repo, facts.number, facts.head));
            assert.equal(governs(r.token, 'acme/other', facts.number, facts.head), false);
          }
  assert.equal(checked, sources.length * authors.length * headRepos.length * bases.length * labelSets.length);
  assert.ok(governed > 0, 'the property is not vacuous');
});
