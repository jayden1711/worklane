// Who a chat sender is, and what they may do from a thread. A Discord user is taken only when they are an allowed
// sender (discord.allowed_senders) AND mapped to a GitHub login (discord.people, in the instance's own intake.yaml,
// never in the repo). Their role is that login's permission on the instance's repo, read exactly as the dashboard
// reads it (dashboard-auth.ts: admin -> owner, maintain/write -> writer, triage/read -> viewer, anything else none).
// An unmapped sender is ignored entirely: nothing of theirs is stored or answered.
import { mayAnswerKind } from '../dashboard-auth.js';
import { mayAnswerAsk } from '../console/asks.js';
/** The GitHub login a Discord user stands for, or null when they aren't both allowed and mapped. */
export function loginOf(cfg, discordId) {
    if (!cfg.discord.allowed_senders.includes(discordId))
        return null;
    return Object.hasOwn(cfg.discord.people, discordId) ? cfg.discord.people[discordId] : null;
}
/** The person behind a Discord user id, with their repo role; null when unmapped (ignored). */
export async function personOf(cfg, discordId, roleOf) {
    const login = loginOf(cfg, discordId);
    if (!login)
        return null;
    let role = null;
    try {
        role = roleOf ? await roleOf(login) : null;
    }
    catch {
        role = null;
    }
    return { id: discordId, login, role };
}
/**
 * Decision kinds no ordinary chat reply ever answers: high-risk (L3) merges, and an automation's run (approved
 * only by a click on the dashboard). Only an owner listed in discord.owners
 * approves one from a thread, naming its number (mayApproveHighRisk; src/coordinator/channel.ts).
 */
export const NEVER_FROM_CHAT = new Set(['land', 'automation']);
/**
 * THE rule for answering a decision from a chat thread: the dashboard's own (mayAnswerKind: an admin answers owner
 * decisions, a writer the rest), except the kinds that never come from chat. Anyone else's reply is a comment.
 */
export function mayAnswerFromChat(kind, role) {
    return !NEVER_FROM_CHAT.has(kind) && mayAnswerKind(kind, role);
}
/**
 * THE rule for a high-risk (L3) approval from a thread, and for a setup step's one-time link: the sender is in
 * intake.yaml discord.owners AND their mapped login is an admin on the repo now. A mapped writer, a mapped admin
 * who isn't listed, or anyone else: never (their reply is a comment).
 */
export function mayApproveHighRisk(cfg, discordId, role) {
    return role === 'owner' && cfg.discord.owners.includes(discordId) && loginOf(cfg, discordId) !== null;
}
/** Setup-console asks a thread reply may answer: questions and approval links, by the console's own rule. */
export function mayAnswerAskFromChat(ask, role) {
    return (ask.kind === 'question' || ask.kind === 'approve_link') && mayAnswerAsk(ask, role);
}
/** Who may add an idea (open a conversation): an admin or a writer. A viewer's or an unmapped person's never opens one. */
export const mayAddIdea = (role) => role === 'owner' || role === 'writer';
/**
 * THE rule for filing an idea `ready` by a yes: the person who posted it (an admin or a writer), or any admin. A
 * viewer's yes, another writer's, or an unmapped person's files nothing.
 */
export const mayFileReady = (role, isPoster) => role === 'owner' || (isPoster && role === 'writer');
//# sourceMappingURL=people.js.map