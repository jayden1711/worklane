import type { RunRecord } from './run-record.js';
export declare function unreadFiles(changed: string[], record: Pick<RunRecord, 'read' | 'diffedAll'> | null): string[];
