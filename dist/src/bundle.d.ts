/**
 * Write a bundle: `files` (name -> text) into `root/<id>/`, readable by group `gid` only. Returns the directory.
 * Text is redacted; names that aren't plain file names, or an id that isn't one, are refused. `binary`: files kept
 * byte for byte (a chat's image attachment, for the Read tool to view), under the same name rules.
 */
export declare function writeBundle(root: string, id: string, gid: number, files: Record<string, string>, binary?: Record<string, Buffer>): string;
