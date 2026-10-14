// Voice intake and spoken approvals, as the page decides them (the server decides again: src/voice.ts).
// What is heard is shown first, never acted on: a spoken idea, or "approve <n>" with the item, its title and what
// approving does. Only "confirm" within CONFIRM_WINDOW_MS (or a click on the banner) acts, once, on exactly the item
// shown. "cancel", or anything else said in the window, cancels; a "confirm" after it does nothing. Nothing is
// heard or done unless an owner turned it on and the tab is focused and visible.
import type { Decision, State, Task } from '../api';
import type { VoicePrefs } from './prefs';

/** How long a spoken confirm stays open (src/voice.ts VOICE_WINDOW_MS). */
export const CONFIRM_WINDOW_MS = 10_000;

/** What a final piece of speech says. */
export type Heard = { kind: 'confirm' } | { kind: 'cancel' } | { kind: 'approve'; issue: number } | { kind: 'idea'; text: string } | { kind: 'empty' };

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[.,!?;:"“”'’]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Read what was said: exactly "confirm", exactly "cancel", "approve <n>" ("number", "issue" or "#" allowed), or an idea. */
export function parseHeard(text: string): Heard {
  const w = words(text);
  if (!w.length) return { kind: 'empty' };
  if (w.length === 1 && w[0] === 'confirm') return { kind: 'confirm' };
  if (w.length === 1 && w[0] === 'cancel') return { kind: 'cancel' };
  const m = /^approve (?:number |issue |pr )?#?(\d{1,9})$/.exec(w.join(' '));
  if (m) return { kind: 'approve', issue: Number(m[1]) };
  return { kind: 'idea', text: text.trim() };
}

/** An item "approve <n>" may approve, or why not. */
export type ApprovalItem = { ok: true; issue: number; decision: string; title: string; effect: string } | { ok: false; issue: number; why: string };

const EFFECT: Record<string, string> = {
  intake: 'the report is filed as a ready issue, and the agents may start on it',
  plan: 'the build starts with this plan',
};

/**
 * What "approve <n>" would approve: the one open decision on issue n that has an approve option, its task's title
 * and what approving does. Refused (with why) when there is none, more than one, or voice may never approve it (the
 * server's word: Decision.voiceRefused), or this person can't answer it.
 */
export function approvalFor(state: { decisions: Decision[]; tasks: Pick<Task, 'issue' | 'title'>[] }, issue: number): ApprovalItem {
  const open = state.decisions.filter((d) => !d.answer && d.issue === issue && d.options.includes('approve'));
  if (!open.length) return { ok: false, issue, why: `nothing on #${issue} waits for an approval` };
  if (open.length > 1) return { ok: false, issue, why: `more than one approval waits on #${issue}; approve it with a click` };
  const d = open[0]!;
  if (d.canAnswer === false) return { ok: false, issue, why: "you can't answer this one" };
  // INVARIANT: absent means the server didn't say voice may approve it (an older server, or not an owner): refused.
  if (d.voiceRefused !== null) return { ok: false, issue, why: d.voiceRefused ? `it can't be approved by voice: ${d.voiceRefused}` : "the server didn't confirm voice may approve it; approve it with a click" };
  const title = state.tasks.find((t) => t.issue === issue)?.title ?? d.question;
  const effect = d.receipts?.find((r) => r.startsWith('approve: '))?.slice('approve: '.length) ?? EFFECT[d.kind] ?? `"${d.question}" is answered "approve"`;
  return { ok: true, issue, decision: d.id, title, effect };
}

/** What waits for a confirm: a spoken idea, an approval, or a refusal that is only shown. */
export type Pending = ({ kind: 'intake'; text: string } | { kind: 'approve'; issue: number; decision: string; title: string; effect: string } | { kind: 'refused'; issue: number; why: string }) & { until: number };

/** What the page does next. */
export type Step =
  | { do: 'show'; pending: Pending }
  | { do: 'send-intake'; text: string }
  | { do: 'approve'; issue: number; decision: string }
  | { do: 'cancelled'; why: string }
  | { do: 'nothing'; why: string };

/** The tab's state, as the server is told it. */
export function tabState(doc: { hasFocus(): boolean; visibilityState: string } | undefined = typeof document === 'undefined' ? undefined : document) {
  return { focused: !!doc && doc.hasFocus(), visible: !!doc && doc.visibilityState === 'visible' };
}

/** Whether this person gets voice intake and approvals at all: the instance's owners, once one turned it on in Settings. */
export const mayUseVoice = (role: string | null | undefined, prefs: VoicePrefs) => role === 'owner' && prefs.voiceCommands;

/** Whether voice may do anything now: an owner who turned it on, in a focused and visible tab. */
export function voiceActive(role: string | null | undefined, prefs: VoicePrefs, tab: { focused: boolean; visible: boolean }): boolean {
  return mayUseVoice(role, prefs) && tab.focused && tab.visible;
}

/** The spoken-confirm state machine: at most one pending item; one confirm acts on it once. */
export class VoiceCommands {
  pending: Pending | null = null;
  constructor(
    private readonly o: { find: (issue: number) => ApprovalItem; now?: () => number },
  ) {}

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** The pending item while its window is open; a closed one is dropped. */
  live(): Pending | null {
    if (this.pending && this.now() > this.pending.until) this.pending = null;
    return this.pending;
  }

  /** A final piece of speech. `active`: voiceActive now; when it isn't, nothing happens and nothing stays pending. */
  hear(text: string, active: boolean): Step {
    if (!active) {
      this.pending = null;
      return { do: 'nothing', why: 'voice is off, or the tab is not focused and visible' };
    }
    const h = parseHeard(text);
    if (h.kind === 'empty') return { do: 'nothing', why: 'nothing was said' };
    const p = this.live();
    if (p) {
      // INVARIANT: in the window, only "confirm" acts, and only on what is shown; anything else said cancels it.
      this.pending = null;
      if (h.kind === 'confirm') return act(p);
      return { do: 'cancelled', why: h.kind === 'cancel' ? 'cancelled' : 'cancelled: something else was said' };
    }
    if (h.kind === 'confirm') return { do: 'nothing', why: 'nothing waits for a confirm (a confirm counts only within 10 s)' };
    if (h.kind === 'cancel') return { do: 'nothing', why: 'nothing to cancel' };
    const until = this.now() + CONFIRM_WINDOW_MS;
    if (h.kind === 'approve') {
      const a = this.o.find(h.issue);
      this.pending = a.ok ? { kind: 'approve', issue: a.issue, decision: a.decision, title: a.title, effect: a.effect, until } : { kind: 'refused', issue: a.issue, why: a.why, until };
    } else this.pending = { kind: 'intake', text: h.text, until };
    return { do: 'show', pending: this.pending };
  }

  /** The banner's button: the same as saying "confirm" (within the window, once). */
  click(active: boolean): Step {
    const p = this.live();
    this.pending = null;
    if (!active) return { do: 'nothing', why: 'voice is off, or the tab is not focused and visible' };
    if (!p) return { do: 'nothing', why: 'nothing waits for a confirm' };
    return act(p);
  }

  cancel(): Step {
    const had = this.live();
    this.pending = null;
    return had ? { do: 'cancelled', why: 'cancelled' } : { do: 'nothing', why: 'nothing to cancel' };
  }
}

function act(p: Pending): Step {
  if (p.kind === 'intake') return { do: 'send-intake', text: p.text };
  if (p.kind === 'approve') return { do: 'approve', issue: p.issue, decision: p.decision };
  return { do: 'nothing', why: p.why };
}

/** What the banner says aloud (talk-back) and shows. */
export function bannerText(p: Pending): string {
  if (p.kind === 'intake') return `Heard: ${p.text}. Say confirm within 10 seconds to send it to intake, or anything else to cancel.`;
  if (p.kind === 'approve') return `Approve number ${p.issue}, ${p.title}. Approving means: ${p.effect}. Say confirm within 10 seconds, or anything else to cancel.`;
  return `Number ${p.issue} can't be approved by voice: ${p.why}.`;
}

/** The approval lookup over the state the page has. */
export const finder = (state: Pick<State, 'decisions' | 'tasks'>) => (issue: number) => approvalFor(state, issue);
