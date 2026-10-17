import { type HealthStatus, type Incident } from './incidents.js';
export interface IncidentsView {
    instance: string | null;
    status: HealthStatus;
    open: Partial<Incident>[];
    resolved: Partial<Incident>[];
    /** Whether each incident's detail, what was tried and its fix are included (owners and writers). */
    detail: boolean;
}
export declare function incidentsView(o: {
    dir?: string;
    instance: string | null;
    full: boolean;
}): IncidentsView;
