import { localDay } from './local-day.js';
import { MODEL_TIERS, tierOf } from './model-routing.js';
import { providerOf } from './providers.js';
import { effectiveRouting, route } from './routing.js';
import { CROSS_FAMILY_OFF } from './cross-eval.js';
/** What --effort may be set to from the chat (claude 2.1.296 also has xhigh and max; not offered: not every model has xhigh, and they cost the most). */
export const CHAT_EFFORTS = ['low', 'medium', 'high'];
/**
 * The single-shot chat's one stream per instance (POST /api/chat): its spend counts here, a day at a time. A
 * conversation (src/chat-conversations.ts) counts under its own id, over its whole life.
 */
export const MAIN_CONVERSATION = 'default';
/**
 * A conversation's cap when agents.yaml sets none. WHY $5: five answers at the per-answer default ($1,
 * roles.chief_of_staff.budget_usd); a typical answer is cents, so a few dozen; the daily budget still bounds it.
 */
export const DEFAULT_CONVERSATION_CAP_USD = 5;
/**
 * What one person who isn't an owner may spend on chat in a local day, across all their conversations, when
 * policy.yaml settings.chat.person_daily_usd sets nothing. WHY $10: two conversations at their default cap; owners
 * are exempt (they hold the daily budget anyway).
 */
export const DEFAULT_PERSON_DAILY_USD = 10;
/** The chat's default model: routing.chat, else roles.chief_of_staff.model, else sonnet. Never an open model (the schema refuses one). */
export function chatDefaultModel(agents) {
    return route(agents, 'chat').value;
}
/** Every Anthropic model routing names (in effect, the chat's default first), and chief_of_staff's: the only ones the chat runs on. */
export function chatModels(agents) {
    const named = [chatDefaultModel(agents), ...effectiveRouting(agents).map((r) => r.value), agents.roles.chief_of_staff?.model];
    return [...new Set(named.filter((m) => typeof m === 'string' && m.length > 0 && m !== CROSS_FAMILY_OFF && !providerOf(m)))];
}
/** The models this person may pick: all of chatModels for the owner; for a writer, those at or below the default's tier; none for a viewer. */
export function pickableModels(agents, picker) {
    if (picker === 'viewer')
        return [];
    const all = chatModels(agents);
    if (picker === 'owner')
        return all;
    const ceiling = tierOf(chatDefaultModel(agents));
    const rank = (m) => {
        const t = tierOf(m);
        return t === null ? Infinity : MODEL_TIERS.indexOf(t);
    };
    // A default of no known tier: a writer gets the default only.
    return all.filter((m) => m === chatDefaultModel(agents) || (ceiling !== null && rank(m) <= MODEL_TIERS.indexOf(ceiling)));
}
/** Why this person may not make this pick, or null. */
export function pickRefusal(agents, picker, pick) {
    if (!pick || (pick.model === undefined && pick.effort === undefined))
        return null;
    if (picker === 'viewer')
        return "viewers can't pick the chat's model or effort";
    if (pick.effort !== undefined && !CHAT_EFFORTS.includes(pick.effort))
        return `effort must be one of ${CHAT_EFFORTS.join(', ')}`;
    if (pick.model !== undefined) {
        if (!chatModels(agents).includes(pick.model))
            return `${pick.model} is not a model agents.yaml routing names for this instance`;
        if (!pickableModels(agents, picker).includes(pick.model))
            return `a writer may pick only a model at or below the default's price tier (${chatDefaultModel(agents)}); ${pick.model} is not`;
    }
    return null;
}
/** A conversation's cap, from agents.yaml. */
export function conversationCapUsd(agents) {
    return agents.roles.chief_of_staff?.conversation_budget_usd ?? DEFAULT_CONVERSATION_CAP_USD;
}
/**
 * What a conversation has spent, from the run.cost events of its chat answers. Main's single conversation never
 * ends, so its window is the machine's local day (localDay; owner, 2026-10-15: budgets follow the local day):
 * otherwise its cap would close main's chat for good.
 */
export function conversationSpentUsd(costs, conversation, now = new Date()) {
    const day = localDay(now);
    return costs.reduce((s, e) => {
        const p = e.payload;
        if (p.role !== 'chat' || p.conversation !== conversation || typeof p.usd !== 'number')
            return s;
        if (conversation === MAIN_CONVERSATION && localDay(e.ts) !== day)
            return s;
        return s + p.usd;
    }, 0);
}
/** What a person has spent on chat answers today (the machine's local day), in any conversation or none. */
export function personSpentUsd(costs, by, now = new Date()) {
    const day = localDay(now);
    const who = by.toLowerCase();
    return costs.reduce((s, e) => {
        const p = e.payload;
        if (p.role !== 'chat' || typeof p.by !== 'string' || p.by.toLowerCase() !== who || typeof p.usd !== 'number' || localDay(e.ts) !== day)
            return s;
        return s + p.usd;
    }, 0);
}
/** When today's local day ends, in words, for a refusal: the next local midnight. */
export function nextLocalMidnight(now = new Date()) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}
/**
 * The one seam: what this answer runs on and may spend, or why it may not run. Called by the coordinator before
 * every answer (the dashboard checks the pick too, to refuse early); `picker` is the role the dashboard read.
 */
export function chatRunOptions(o) {
    if (!o.conversation)
        return { ok: false, why: 'no conversation' };
    const refused = pickRefusal(o.agents, o.picker, o.pick);
    if (refused)
        return { ok: false, why: refused };
    const capUsd = conversationCapUsd(o.agents);
    const convLeft = capUsd - o.spentUsd;
    if (convLeft <= 0)
        return { ok: false, why: `this conversation's budget ($${capUsd}) is spent ($${o.spentUsd.toFixed(2)})` };
    if (o.dailyLeftUsd <= 0)
        return { ok: false, why: "today's budget is spent" };
    // Per person (anyone but an owner; null for an owner): today's chat spend across all their conversations.
    const personLeft = o.person ? o.person.capUsd - o.person.spentUsd : Infinity;
    if (o.person && personLeft <= 0)
        return { ok: false, why: `your chat spend today has reached the per-person cap ($${o.person.capUsd}; $${o.person.spentUsd.toFixed(2)} spent); it resets at local midnight (${o.person.resets.toString().slice(0, 21)})` };
    const roleCap = o.agents.roles.chief_of_staff?.budget_usd ?? 1;
    return {
        ok: true,
        model: o.pick?.model ?? chatDefaultModel(o.agents),
        ...(o.pick?.effort ? { effort: o.pick.effort } : {}),
        maxBudgetUsd: Math.min(roleCap, convLeft, o.dailyLeftUsd, personLeft),
        conversation: o.conversation,
        capUsd,
        spentUsd: o.spentUsd,
    };
}
/** What the dashboard's picker shows this person. */
export function chatPickerView(agents, picker) {
    return { canPick: picker !== 'viewer', models: pickableModels(agents, picker), efforts: picker === 'viewer' ? [] : CHAT_EFFORTS, defaultModel: chatDefaultModel(agents), capUsd: conversationCapUsd(agents) };
}
//# sourceMappingURL=chat-pick.js.map