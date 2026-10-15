// Where a dashboard key lives, kept apart from src/dashboard.ts so the hook (run on every tool call) loads only this.

/**
 * Every agent session is denied any dashboard key, wherever it is (src/hook.ts): a checkout's (`<state>/projects/<hash>/
 * dashboard-token`), an instance's and the hub's all use this one file name. WHY: in local mode the agents run as the
 * person's own OS user, so the file's 0600 doesn't keep them out; this does (#508).
 */
export const DASHBOARD_KEY_GLOB = '/**/dashboard-token';
