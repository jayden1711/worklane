import type { Config } from './config/load.js';
/** What --effort may be set to from the chat (claude 2.1.296 also has xhigh and max; not offered: not every model has xhigh, and they cost the most). */
export declare const CHAT_EFFORTS: readonly ["low", "medium", "high"];
export type ChatEffort = (typeof CHAT_EFFORTS)[number];
/**
 * The single-shot chat's one stream per instance (POST /api/chat): its spend counts here, a day at a time. A
 * conversation (src/chat-conversations.ts) counts under its own id, over its whole life.
 */
export declare const MAIN_CONVERSATION = "default";
/**
 * A conversation's cap when agents.yaml sets none. WHY $5: five answers at the per-answer default ($1,
 * roles.chief_of_staff.budget_usd); a typical answer is cents, so a few dozen; the daily budget still bounds it.
 */
export declare const DEFAULT_CONVERSATION_CAP_USD = 5;
/**
 * What one person who isn't an owner may spend on chat in a local day, across all their conversations, when
 * policy.yaml settings.chat.person_daily_usd sets nothing. WHY $10: two conversations at their default cap; owners
 * are exempt (they hold the daily budget anyway).
 */
export declare const DEFAULT_PERSON_DAILY_USD = 10;
export type Picker = 'owner' | 'writer' | 'viewer';
export interface ChatPick {
    model?: string;
    effort?: ChatEffort;
}
type Agents = Pick<Config['agents'], 'roles' | 'routing' | 'routing_from'>;
/** The chat's default model: routing.chat, else roles.chief_of_staff.model, else sonnet. Never an open model (the schema refuses one). */
export declare function chatDefaultModel(agents: Agents): string;
/** Every Anthropic model routing names (in effect, the chat's default first), and chief_of_staff's: the only ones the chat runs on. */
export declare function chatModels(agents: Agents): string[];
/** The models this person may pick: all of chatModels for the owner; for a writer, those at or below the default's tier; none for a viewer. */
export declare function pickableModels(agents: Agents, picker: Picker): string[];
/** Why this person may not make this pick, or null. */
export declare function pickRefusal(agents: Agents, picker: Picker, pick: ChatPick | undefined): string | null;
/** A conversation's cap, from agents.yaml. */
export declare function conversationCapUsd(agents: Agents): number;
/**
 * What a conversation has spent, from the run.cost events of its chat answers. Main's single conversation never
 * ends, so its window is the machine's local day (localDay; owner, 2026-10-15: budgets follow the local day):
 * otherwise its cap would close main's chat for good.
 */
export declare function conversationSpentUsd(costs: {
    ts: string;
    payload: unknown;
}[], conversation: string, now?: Date): number;
/** What a person has spent on chat answers today (the machine's local day), in any conversation or none. */
export declare function personSpentUsd(costs: {
    ts: string;
    payload: unknown;
}[], by: string, now?: Date): number;
/** When today's local day ends, in words, for a refusal: the next local midnight. */
export declare function nextLocalMidnight(now?: Date): Date;
export type ChatRunOptions = {
    ok: true;
    model: string;
    effort?: ChatEffort;
    maxBudgetUsd: number;
    conversation: string;
    capUsd: number;
    spentUsd: number;
} | {
    ok: false;
    why: string;
};
/**
 * The one seam: what this answer runs on and may spend, or why it may not run. Called by the coordinator before
 * every answer (the dashboard checks the pick too, to refuse early); `picker` is the role the dashboard read.
 */
export declare function chatRunOptions(o: {
    agents: Agents;
    picker: Picker;
    pick?: ChatPick;
    conversation: string;
    spentUsd: number;
    dailyLeftUsd: number;
    person?: {
        capUsd: number;
        spentUsd: number;
        resets: Date;
    } | null;
}): ChatRunOptions;
/** What the dashboard's picker shows this person. */
export declare function chatPickerView(agents: Agents, picker: Picker): {
    canPick: boolean;
    models: string[];
    efforts: readonly ChatEffort[];
    defaultModel: string;
    capUsd: number;
};
export {};
