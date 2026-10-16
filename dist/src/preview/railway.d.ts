export interface PreviewEnv {
    id: string;
    name: string;
    createdAt: string;
}
export interface PreviewHost {
    environments(): Promise<PreviewEnv[]>;
    create(name: string): Promise<string>;
    remove(id: string): Promise<boolean>;
    deploy(environment: string, service: string, sha: string): Promise<string>;
    deployment(id: string): Promise<{
        status: string;
        domain: string | null;
    }>;
    domain(environment: string, service: string): Promise<string>;
}
export declare const PREVIEW_QUERIES: {
    readonly ENVS: "query($p:String!){environments(projectId:$p){edges{node{id name createdAt}}}}";
    readonly CREATE: "mutation($i:EnvironmentCreateInput!){environmentCreate(input:$i){id}}";
    readonly DELETE: "mutation($id:String!){environmentDelete(id:$id)}";
    readonly DEPLOY: "mutation($s:String!,$e:String!,$c:String){serviceInstanceDeployV2(serviceId:$s,environmentId:$e,commitSha:$c)}";
    readonly STATUS: "query($id:String!){deployment(id:$id){id status staticUrl}}";
    readonly DOMAIN: "mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}";
};
export declare const isDomain: (d: unknown) => d is string;
export declare function railwayPreviewHost(ids: {
    project: string;
    template: string;
}, token: () => string | null, f?: typeof fetch, api?: string): PreviewHost;
