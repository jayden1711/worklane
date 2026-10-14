// docs/previews.md: tests.yaml `preview:`. INVARIANT: off unless `enabled: true`; a present block is still validated.
import { z } from 'zod';

const railwayId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a Railway id (a UUID)');
const shortName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'a short name (lowercase letters, digits, _ or -)');

export const PREVIEW_ENV_PREFIX = 'pr-preview-';

export const PreviewConfig = z
  .strictObject({
    enabled: z.boolean().default(false),
    host: z.literal('railway').default('railway'),
    project: railwayId.optional(),
    template_environment: railwayId.optional(),
    services: z
      .array(z.strictObject({ name: shortName, id: railwayId }))
      .min(1)
      .max(20)
      .refine((s) => new Set(s.map((x) => x.id)).size === s.length && new Set(s.map((x) => x.name)).size === s.length, 'each service once')
      .optional(),
    url_service: shortName.optional(),
    flows: z.array(z.string().min(1).max(60)).max(20).optional(),
    max_concurrent: z.number().int().min(1).max(10).default(2),
    timeout_s: z.number().int().min(60).max(7200).default(1200),
    ttl_hours: z.number().int().min(1).max(720).default(72),
  })
  .superRefine((p, ctx) => {
    if (!p.enabled) return;
    for (const k of ['project', 'template_environment', 'services', 'url_service'] as const) {
      if (p[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: `needed when preview.enabled is true` });
    }
    if (p.url_service && p.services && !p.services.some((s) => s.name === p.url_service)) ctx.addIssue({ code: 'custom', path: ['url_service'], message: 'one of preview.services' });
  });
export type PreviewConfig = z.infer<typeof PreviewConfig>;

export function previewPr(name: string): number | null {
  const m = new RegExp(`^${PREVIEW_ENV_PREFIX}([1-9][0-9]{0,8})$`).exec(name);
  return m ? Number(m[1]) : null;
}
