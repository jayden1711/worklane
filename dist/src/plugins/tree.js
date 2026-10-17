// WHY: an approved plugin is pinned by what we run, not only by what we fetched. A git commit SHA names the source;
// `wl-tree-v1` names the exact bytes of the materialized directory (after a sparse checkout and our own transforms),
// is checked before every agent run, and doesn't rest on SHA-1. Claude Code's own plugin "version" is a 12-character
// SHA prefix with no content check (plugins/loading docs), so it can't serve here.
//
// wl-tree-v1: for every regular file, sorted by its relative path's UTF-8 bytes, the line
//   <644|755> NUL <relative path, '/'-separated> NUL <sha256 hex of the content> LF
// and the tree hash is sha256 of those lines. Anything that isn't a directory or a regular file (a symlink, a device,
// a socket, a FIFO), a file with more than one hard link, or a path we refuse (below) makes the tree unhashable:
// an error, never a hash that skips it.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const TREE_PREFIX = 'wl-tree-v1:sha256:';
export const DEFAULT_TREE_LIMITS = { maxFiles: 2000, maxBytes: 50 * 1024 * 1024 };
export class TreeError extends Error {
}
/**
 * A path segment we refuse: empty, `.`/`..`, a backslash (Claude Code rejects those on POSIX), control characters,
 * and bidi or invisible formatting characters, which can make a path read as something else on the review page.
 */
// eslint-disable-next-line no-control-regex
const BAD_SEGMENT = /^\.{0,2}$|[\\\u0000-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
/** Every regular file under `root`, with its mode class and content hash, in wl-tree-v1 order. Throws TreeError. */
export function treeFiles(root, limits = DEFAULT_TREE_LIMITS) {
    const out = [];
    let bytes = 0;
    const walk = (dir, rel) => {
        for (const name of readdirSync(dir)) {
            if (BAD_SEGMENT.test(name))
                throw new TreeError(`refused path segment ${JSON.stringify([...rel, name].join('/'))}`);
            const abs = join(dir, name);
            const p = [...rel, name];
            const st = lstatSync(abs);
            if (st.isDirectory())
                walk(abs, p);
            else if (st.isFile()) {
                if (st.nlink > 1)
                    throw new TreeError(`${p.join('/')} is a hard link`);
                if (out.length >= limits.maxFiles)
                    throw new TreeError(`more than ${limits.maxFiles} files`);
                bytes += st.size;
                if (bytes > limits.maxBytes)
                    throw new TreeError(`more than ${limits.maxBytes} bytes`);
                const content = readFileSync(abs);
                out.push({ path: p.join('/'), mode: st.mode & 0o111 ? '755' : '644', size: st.size, sha256: createHash('sha256').update(content).digest('hex') });
            }
            else
                throw new TreeError(`${p.join('/')} is ${st.isSymbolicLink() ? 'a symlink' : 'not a regular file or directory'}`);
        }
    };
    walk(root, []);
    return out.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
}
/** The wl-tree-v1 hash of a list of files (already in order). */
export function treeHashOf(files) {
    const h = createHash('sha256');
    for (const f of files)
        h.update(`${f.mode}\0${f.path}\0${f.sha256}\n`, 'utf8');
    return TREE_PREFIX + h.digest('hex');
}
/** The wl-tree-v1 hash of the directory at `root`. Throws TreeError for anything it can't hash. */
export function treeHash(root, limits) {
    return treeHashOf(treeFiles(root, limits));
}
//# sourceMappingURL=tree.js.map