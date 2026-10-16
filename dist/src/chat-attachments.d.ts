import type { InstanceSettings } from './instance.js';
export declare const ATTACHMENTS_DIR = "chat-attachments";
export declare const ATTACHMENT_ID: RegExp;
/** At most this many files on one question. */
export declare const MAX_ATTACHMENTS = 10;
export interface AttachmentCaps {
    max_file_mb: number;
    max_message_mb: number;
    retention_days: number;
}
export declare const ATTACHMENT_DEFAULT_CAPS: AttachmentCaps;
/** The caps in force: the instance's settings (policy.yaml settings.chat_attachments), else the engine's defaults. */
export declare function attachmentCaps(s: InstanceSettings): AttachmentCaps;
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'csv' | 'json' | 'office';
/** The kinds the secret scan reads (text). Images, PDFs and Office files are kept unread: the upload says so. */
export declare const SCANNED_KINDS: readonly AttachmentKind[];
interface TypeRule {
    kind: AttachmentKind;
    /** The one Content-Type it is served with. */
    mime: string;
    /** What the bytes must start with (images, PDF, Office's zip); text kinds are checked as text instead. */
    magic?: (head: Buffer) => boolean;
    label: string;
}
/** The extensions the chat takes, for the upload button's accept list and the docs. */
export declare const ATTACHMENT_EXTENSIONS: string[];
export interface AttachmentMeta {
    v: 1;
    id: string;
    /** The uploader's file name, for display and the download's file name only: never part of a path. */
    name: string;
    kind: AttachmentKind;
    /** The type it is served with (from the allowlist, never the client's). */
    mime: string;
    label: string;
    size: number;
    sha256: string;
    at: string;
    by: string;
    /** Kinds of secret the scan saw (names, never values), when it was attached anyway. */
    secretKinds: string[];
}
/** What the browser and events see of an attachment. */
export type AttachmentView = Pick<AttachmentMeta, 'id' | 'name' | 'kind' | 'label' | 'size' | 'sha256'>;
export declare const attachmentView: (m: AttachmentMeta) => AttachmentView;
export declare class AttachmentError extends Error {
    readonly status: number;
    readonly secretKinds: string[];
    constructor(message: string, status: number, secretKinds?: string[]);
}
/** A display name: the last path part, no control characters, at most 200 characters (code points). Never used as a path. */
export declare function cleanName(raw: string): string;
/** The type rule for a file name, or why it is refused. */
export declare function typeOf(name: string): TypeRule | string;
/** Whether the bytes are the type the name says: a magic number, or text (valid UTF-8, no NUL). */
export declare function sniff(rule: TypeRule, head: Buffer, whole: () => Buffer): string | null;
export interface StoreUpload {
    stateDir: string;
    /** The name the client gave (a header): display only. */
    name: string;
    /** The request body, read as it streams; never buffered whole. */
    body: AsyncIterable<Buffer | string>;
    /** The client's Content-Length, when it sent one: over the cap is refused before a byte is read. */
    declaredLength?: number | null;
    caps: AttachmentCaps;
    by: string;
    /** The uploader saw the secret warning and chose to attach it anyway. */
    anyway?: boolean;
    /** gitleaks over a file (src/scan/secrets.ts); null: the engine's patterns only. */
    gitleaks?: ((path: string) => Promise<string[]>) | null;
    now?: Date;
}
/**
 * Take one upload: stream it to a private temp file (refusing it the moment it passes the per-file cap), check its
 * type against the allowlist and its bytes, scan text for secrets, then keep it under a fresh random id. Throws an
 * AttachmentError (with the HTTP status to answer) when refused; nothing is kept then.
 */
export declare function storeUpload(o: StoreUpload): Promise<AttachmentMeta>;
/** An attachment's record, or null (no such id, or not one). */
export declare function readAttachment(stateDir: string, id: string): AttachmentMeta | null;
/** An attachment's bytes (its record read first: an id without one is never read). */
export declare function attachmentBytes(stateDir: string, id: string): Buffer | null;
export declare function removeAttachment(stateDir: string, id: string): boolean;
/**
 * The attachments a question (or a Project) names: each must exist and be `by`'s own upload, at most
 * MAX_ATTACHMENTS, together within the per-message cap. Returns their records in the order given; throws an
 * AttachmentError otherwise. Someone else's id reads exactly like an unknown one, so it tells nobody it exists.
 */
export declare function attachmentsFor(stateDir: string, ids: unknown, caps: AttachmentCaps, by: string): AttachmentMeta[];
/** The headers an attachment is served with: its allowlisted type, never sniffed, never inline unless an image. */
export declare function downloadHeaders(m: AttachmentMeta): Record<string, string>;
/**
 * Delete every attachment older than the retention days, except the ones in `held` (the files chat Projects hold:
 * src/chat-conversations.ts projectFileIds), and any upload left half-written for over an hour. Returns the ids
 * removed. Run by the coordinator (src/coordinator.ts) about once an hour.
 */
export declare function sweepAttachments(stateDir: string, retentionDays: number, held: ReadonlySet<string>, now?: Date): string[];
/** How much attachment text goes into one prompt, in characters: per file and for the question in all. */
export declare const INLINE_PER_FILE = 60000;
export declare const INLINE_TOTAL = 150000;
/**
 * The prompt section and bundle files for a question's attachments. Text goes inline between markers that carry a
 * random nonce (so the text can't fake its own end), redacted; images and PDFs go into the bundle byte for byte, for
 * the Read tool (which shows them; nothing runs); Office files are named and described, never unpacked. Everything
 * is framed as untrusted data.
 */
export declare function attachmentPrompt(stateDir: string, ids: string[], bundleDir: string, nonce?: string): {
    text: string;
    binary: Record<string, Buffer>;
};
export {};
