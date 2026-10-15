// Which Tailscale device a terminal request comes from, and whether it's one the owner allowed (the hub's
// console_devices: Tailscale tags such as tag:owner-laptop, and/or MagicDNS node names). Fails closed: an empty
// list, an unknown device, or a device that can't be identified is refused.
//
// How the device is identified, behind `tailscale serve --https=443 http://127.0.0.1:<hub port>`:
// 1. The connection must come from tailscaled itself. The hub listens on loopback, so anyone on the machine
//    could connect, and anything they send (headers included) is theirs to choose. The kernel says who opened
//    the connection (/proc/net/tcp: the uid owning the client socket, src/os). Only tailscaled's uid (root)
//    counts. Nothing the client sends decides this.
// 2. tailscaled's serve proxy sets X-Forwarded-For to the peer's Tailscale address. It is Go's
//    httputil.ReverseProxy with a Rewrite func, which drops any inbound X-Forwarded-* before setting its own, so
//    a header a browser sends doesn't survive. So only on a connection from tailscaled is that header
//    trusted, and only as exactly one Tailscale address.
// 3. That address is looked up with Tailscale's own LocalAPI (`tailscale whois --json <ip>`): the node's
//    MagicDNS name and its tags, from the control plane. The Tailscale-User-* headers are never used: serve sets
//    them only for user-owned nodes, and they name a user, not a device.
// The break-glass port (the token, loopback only; #197) never opens a terminal: nothing there says which device.
import { execFileSync } from 'node:child_process';
import { loopbackPeerUid } from '../os/index.js';
/** The break-glass port (#197's HUB_BREAK_GLASS_PORT): the terminal is never served there. */
export const BREAK_GLASS_PORT = 4398;
/** tailscaled's uid: it runs as root. */
export const TAILSCALED_UID = 0;
const V4 = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** A Tailscale address: 100.64/10 (CGNAT), or fd7a:115c:a1e0::/48. */
export function isTailscaleIp(ip) {
    const m = V4.exec(ip);
    if (m) {
        const [b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
        return b >= 64 && b <= 127 && c <= 255 && d <= 255;
    }
    return /^fd7a:115c:a1e0:[0-9a-f:]+$/i.test(ip) && !ip.includes(':::');
}
/** The allowlist as the hub takes it: `tag:a,laptop,<node>.<tailnet>.ts.net`; anything not a tag or a DNS name is dropped. */
export function parseDeviceList(raw) {
    return (raw ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^tag:[a-z0-9-]{1,63}$/.test(s) || /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$/.test(s));
}
/** Whether a device is on the list: one of its tags, or its name (the full MagicDNS name or its first label). */
export function deviceAllowed(d, allow) {
    const name = d.name.toLowerCase().replace(/\.$/, '');
    const short = name.split('.')[0];
    return allow.some((a) => (a.startsWith('tag:') ? d.tags.map((t) => t.toLowerCase()).includes(a) : a === name || a === short));
}
/** The device behind a request, from Tailscale: only for a connection tailscaled made, never from what a client says. */
export function identifyDevice(req, o) {
    const sock = req.socket;
    if (sock.localPort === (o.breakGlassPort ?? BREAK_GLASS_PORT))
        return { ok: false, why: "the terminal isn't served on the break-glass port: open it from an allowed Tailscale device, through the hub's HTTPS address" };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(sock.remoteAddress ?? '') || !sock.remotePort || !sock.localPort)
        return { ok: false, why: "this request didn't come through tailscale serve, so its device can't be identified" };
    const uid = (o.peerUid ?? loopbackPeerUid)(sock.remotePort, sock.localPort);
    if (uid === null)
        return { ok: false, why: "can't tell which program opened this connection, so its Tailscale device can't be identified" };
    if (uid !== TAILSCALED_UID)
        return { ok: false, why: "this request came from a program on the machine, not through tailscale serve, so its device can't be identified" };
    const fwd = req.headers['x-forwarded-for'];
    const ip = typeof fwd === 'string' ? fwd.trim() : '';
    if (!ip || ip.includes(',') || !isTailscaleIp(ip))
        return { ok: false, why: "tailscale serve didn't name the peer's Tailscale address, so its device can't be identified" };
    let who;
    try {
        who = JSON.parse((o.whois ?? defaultWhois)(ip));
    }
    catch {
        return { ok: false, why: `Tailscale couldn't say which device ${ip} is (tailscale whois failed)` };
    }
    const name = typeof who.Node?.Name === 'string' ? who.Node.Name.replace(/\.$/, '') : '';
    const tags = Array.isArray(who.Node?.Tags) ? who.Node.Tags.filter((t) => typeof t === 'string') : [];
    if (!name)
        return { ok: false, why: `Tailscale has no node for ${ip}` };
    return { ok: true, device: { name, tags, ip } };
}
/** Why this request's device may not open the terminal; null when it may. Fails closed. */
export function deviceRefusal(req, o) {
    if (!o.allow.length)
        return { why: 'no Tailscale devices are allowed to open the terminal (console_devices is empty): the owner lists them in dashboards.sh --console-devices', device: null };
    const d = identifyDevice(req, o);
    if (!d.ok)
        return { why: d.why, device: null };
    if (!deviceAllowed(d.device, o.allow))
        return { why: `${d.device.name}${d.device.tags.length ? ` (${d.device.tags.join(', ')})` : ''} isn't one of the devices allowed to open the terminal`, device: d.device };
    return { why: null, device: d.device };
}
const defaultWhois = (ip) => execFileSync('tailscale', ['whois', '--json', ip], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
//# sourceMappingURL=terminal-devices.js.map