// WHY: `dashboard --detach` asks whatever answers on a port whether it is this checkout's dashboard. It used to ask by
// sending the key, so any program listening there first got it (#448). Now the asker sends a random nonce and the
// dashboard answers with an HMAC of it under the key: only a holder of the key can answer, and the key never leaves.
// INVARIANT: the proof is bound to the port the dashboard itself was reached on, so a program on another port that
// relays the nonce to the real dashboard gets a proof for the real port, which the asker refuses.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export const PROOF_PATH = '/api/prove';
/** 32 random bytes, hex: what the asker sends, and the only shape the dashboard answers. */
export const NONCE = /^[0-9a-f]{64}$/;
export const newNonce = () => randomBytes(32).toString('hex');
/** HMAC-SHA256 under the key, over a fixed label, the port and the nonce (hex). The label keeps it to this use. */
export function dashboardProof(key, port, nonce) {
    return createHmac('sha256', key).update(`dashboard-probe-v1\n${port}\n${nonce}`).digest('hex');
}
/** Whether `proof` is the key's proof for this port and nonce, compared in constant time. */
export function proofMatches(key, port, nonce, proof) {
    if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof))
        return false;
    return timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(dashboardProof(key, port, nonce), 'hex'));
}
//# sourceMappingURL=dashboard-proof.js.map