// A dashboard key never travels in a URL. WHY: a URL ends up in proxy logs, browser history, shell scrollback and
// referrers; the key goes in the Authorization header (the page's key form, the live streams read with fetch).
// INVARIANT: every server that takes a dashboard key (the local dashboard, the hub's sign-in port, its break-glass
// port, the terminal's upgrade) refuses a request whose query carries one, with a 401 that never repeats the URL.
import { timingSafeEqual } from 'node:crypto';
/** Query names a key could be sent under (the old `?t=` link among them): refused whatever their value. */
export const KEY_QUERY_NAMES = ['t', 'token', 'key', 'access_token', 'auth', 'authorization', 'api_key', 'apikey', 'bearer', 'password', 'secret'];
/** What a refused request is told. It names no part of the URL. */
export const KEY_IN_URL_REFUSED = "a key in a URL is refused: open the address without it and give the key on the page (it's sent in a header, never the URL)";
const same = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};
/** Whether this URL's query carries a key: a key-shaped name, or any value that is one of `keys` (compared in constant time). */
export function keyInUrl(url, keys = []) {
    for (const [name, value] of url.searchParams) {
        if (KEY_QUERY_NAMES.includes(name.toLowerCase()))
            return true;
        if (keys.some((k) => k && same(value, k)))
            return true;
    }
    return false;
}
/** Refuse (401) a request whose URL carries a key; true when refused. Nothing about the URL is logged or echoed. */
export function refuseKeyInUrl(url, res, keys = []) {
    if (!keyInUrl(url, keys))
        return false;
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify({ error: KEY_IN_URL_REFUSED }));
    return true;
}
/** What a printed dashboard URL is followed by: where its key is (the file), never the key. */
export const keyFileNote = (file) => `(the page asks for the key once: it is in ${file})`;
//# sourceMappingURL=dashboard-key-url.js.map