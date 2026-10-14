// docs/previews.md, "What is verified": these calls are unverified against the live schema.
// INVARIANT: every call goes through the deploy gate's railwayClient, so the token is handled one way only.
import { RAILWAY_API, railwayClient } from '../deploy-gate/railway.js';

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
  deployment(id: string): Promise<{ status: string; domain: string | null }>;
  domain(environment: string, service: string): Promise<string>;
}

const ENVS = 'query($p:String!){environments(projectId:$p){edges{node{id name createdAt}}}}';
const CREATE = 'mutation($i:EnvironmentCreateInput!){environmentCreate(input:$i){id}}';
const DELETE = 'mutation($id:String!){environmentDelete(id:$id)}';
const DEPLOY = 'mutation($s:String!,$e:String!,$c:String){serviceInstanceDeployV2(serviceId:$s,environmentId:$e,commitSha:$c)}';
const STATUS = 'query($id:String!){deployment(id:$id){id status staticUrl}}';
const DOMAIN = 'mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}';

export const PREVIEW_QUERIES = { ENVS, CREATE, DELETE, DEPLOY, STATUS, DOMAIN } as const;

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export const isDomain = (d: unknown): d is string => typeof d === 'string' && DOMAIN_RE.test(d);

export function railwayPreviewHost(ids: { project: string; template: string }, token: () => string | null, f: typeof fetch = fetch, api = RAILWAY_API): PreviewHost {
  const call = railwayClient(token, f, api);
  return {
    environments: async () => {
      const d = await call<{ environments: { edges: { node: { id: string; name: string; createdAt: string } }[] } }>(ENVS, { p: ids.project });
      return d.environments.edges.map(({ node: n }) => ({ id: String(n.id), name: String(n.name), createdAt: String(n.createdAt) }));
    },
    create: async (name) => String((await call<{ environmentCreate: { id: string } }>(CREATE, { i: { projectId: ids.project, name, sourceEnvironmentId: ids.template, ephemeral: true, skipInitialDeploys: true } })).environmentCreate.id),
    remove: async (id) => (await call<{ environmentDelete: boolean }>(DELETE, { id })).environmentDelete === true,
    deploy: async (environment, service, sha) => String((await call<{ serviceInstanceDeployV2: string }>(DEPLOY, { s: service, e: environment, c: sha })).serviceInstanceDeployV2),
    deployment: async (id) => {
      const d = (await call<{ deployment: { status: string; staticUrl?: string | null } }>(STATUS, { id })).deployment;
      return { status: String(d.status), domain: isDomain(d.staticUrl) ? d.staticUrl : null };
    },
    domain: async (environment, service) => {
      const d = (await call<{ serviceDomainCreate: { domain: string } }>(DOMAIN, { i: { environmentId: environment, serviceId: service } })).serviceDomainCreate.domain;
      if (!isDomain(d)) throw new Error(`the host gave no usable domain for the preview`);
      return d;
    },
  };
}
