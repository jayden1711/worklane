import type { ServerResponse } from 'node:http';
/** Query names a key could be sent under (the old `?t=` link among them): refused whatever their value. */
export declare const KEY_QUERY_NAMES: readonly string[];
/** What a refused request is told. It names no part of the URL. */
export declare const KEY_IN_URL_REFUSED = "a key in a URL is refused: open the address without it and give the key on the page (it's sent in a header, never the URL)";
/** Whether this URL's query carries a key: a key-shaped name, or any value that is one of `keys` (compared in constant time). */
export declare function keyInUrl(url: URL, keys?: readonly string[]): boolean;
/** Refuse (401) a request whose URL carries a key; true when refused. Nothing about the URL is logged or echoed. */
export declare function refuseKeyInUrl(url: URL, res: ServerResponse, keys?: readonly string[]): boolean;
/** What a printed dashboard URL is followed by: where its key is (the file), never the key. */
export declare const keyFileNote: (file: string) => string;
