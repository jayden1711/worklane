interface Helpers {
    instance: string | undefined;
    option: (args: string[], name: string) => string | undefined;
    flag: (args: string[], name: string) => boolean;
    usage: string;
}
export declare function harnessEvalCommand(root: string, sub: string | undefined, rest: string[], h: Helpers): Promise<number>;
export {};
