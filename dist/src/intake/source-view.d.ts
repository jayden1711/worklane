export declare class SourceViewError extends Error {
}
export interface SlackView {
    team: {
        id: string;
        name: string;
    };
    bot: {
        user: string;
    };
    /** Public channels in the workspace, and whether the bot is in each (it hears mentions only where it is). */
    channels: {
        id: string;
        name: string;
        member: boolean;
    }[];
    /** People (no bots, no deactivated accounts), to copy ids into slack.allowed_senders. */
    members: {
        id: string;
        name: string;
    }[];
}
export interface LinearView {
    organization: {
        name: string;
    };
    viewer: {
        id: string;
        name: string;
    };
    teams: {
        id: string;
        name: string;
        key: string;
        labels: {
            id: string;
            name: string;
        }[];
        members: {
            id: string;
            name: string;
        }[];
    }[];
    /** Workspace labels (no team): usable in every team. */
    labels: {
        id: string;
        name: string;
    }[];
}
/** The workspace, the bot, the public channels (and whether the bot is in each), and the people. */
export declare function slackView(o: {
    botToken: string;
    fetch?: typeof fetch;
}): Promise<SlackView>;
/** The key's workspace and user, and each team it can see with its labels and members. */
export declare function linearView(o: {
    apiKey: string;
    fetch?: typeof fetch;
}): Promise<LinearView>;
export interface ViewCommandOptions {
    kind: 'slack' | 'linear';
    instance?: string | undefined;
    json?: boolean;
    dir?: string;
    fetch?: typeof fetch;
    out?: (line: string) => void;
    err?: (line: string) => void;
}
/** The CLI command: pick the instance, read its secret, print what it sees. Exit 0, or 1 with one scrubbed line. */
export declare function sourceViewCommand(o: ViewCommandOptions): Promise<number>;
