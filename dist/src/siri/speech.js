// What Siri reads aloud (docs/siri.md): plain text, at most SPEECH_MAX characters, cut at a sentence end. Markdown,
// links, citation ids, code and paths are taken out here, in code, whatever the model wrote: a phone speaks this in
// a room, and the full answer isn't kept for anyone to read later.
import { redactString } from '../events/redact.js';
/** About 25 seconds read aloud. */
export const SPEECH_MAX = 400;
export function toSpeech(text, max = SPEECH_MAX) {
    let s = redactString(String(text ?? ''));
    s = s
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\bhttps?:\/\/\S+/gi, ' ')
        .replace(/\bwww\.\S+/gi, ' ')
        .replace(/\b(?:event|run|pr|issue):#?[A-Za-z0-9_-]+/gi, ' ')
        .replace(/(?:^|\s)(?:\.{0,2}\/)?(?:[\w.-]+\/){1,}[\w.-]+/g, ' ')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
        .replace(/[*_~|>#]+/g, ' ')
        .replace(/[<>{}[\]\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length <= max)
        return s;
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    if (end >= max / 3)
        return cut.slice(0, end + 1).trim();
    const space = cut.lastIndexOf(' ');
    return `${cut.slice(0, space > 0 ? space : max - 1).trim()}…`;
}
//# sourceMappingURL=speech.js.map