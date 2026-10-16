import type { Level } from './review.js';
export declare const DEFAULT_HIGH_RISK_LABELS: string[];
export declare const ROUTING: {
    build: {
        default: string;
        task: string;
    };
    build_high_risk: {
        default: string;
        task: string;
    };
    high_risk_labels: {
        default: string[];
        task: string;
    };
    escalate_after: {
        default: number;
        task: string;
    };
    planner: {
        default: string;
        task: string;
    };
    research: {
        default: string;
        task: string;
    };
    intake_triage: {
        default: string;
        task: string;
    };
    intake_replier: {
        default: string;
        task: string;
    };
    intake_summary: {
        default: string;
        task: string;
    };
    intake_thread: {
        default: string;
        task: string;
    };
    stage_judge: {
        default: string;
        task: string;
    };
    eval_answer: {
        default: string;
        task: string;
    };
    reflection: {
        default: string;
        task: string;
    };
    chat: {
        default: string;
        task: string;
    };
    eval_cheap: {
        default: string;
        task: string;
    };
    eval_cheap_levels: {
        default: Level[];
        task: string;
    };
    eval_escalate: {
        default: boolean;
        task: string;
    };
    eval_cross_family: {
        default: string;
        task: string;
    };
};
export type RoutingKey = keyof typeof ROUTING;
export type Routing = {
    -readonly [K in RoutingKey]: (typeof ROUTING)[K]['default'];
};
export declare const ROUTING_KEYS: RoutingKey[];
export declare const ROUTING_ALIASES: {
    model_routing: Record<string, RoutingKey>;
    eval_routing: Record<string, RoutingKey>;
};
interface RoutingSource {
    roles: {
        workers?: {
            model: string;
            hard_issues_model?: string | undefined;
            [k: string]: unknown;
        } | undefined;
        researcher?: {
            model: string;
            [k: string]: unknown;
        } | undefined;
        [k: string]: unknown;
    };
    routing?: Partial<Routing>;
    routing_from?: Partial<Record<RoutingKey, string>>;
}
export interface RouteValue<K extends RoutingKey = RoutingKey> {
    key: K;
    value: Routing[K];
    /** INVARIANT: null means the default in code. */
    from: string | null;
}
export declare function route<K extends RoutingKey>(a: RoutingSource, key: K): RouteValue<K>;
export declare function effectiveRouting(a: RoutingSource): RouteValue[];
export {};
