import type { EventLog } from './events/log.js';
export declare function renamedFrom(o: {
    stateDir: string;
    log: EventLog;
    from: string;
    to: string;
    now?: Date;
}): {
    revoked: string[];
    carried: {
        from: string;
        to: string;
    }[];
};
