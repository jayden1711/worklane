import { z } from 'zod';
export declare const PREVIEW_ENV_PREFIX = "pr-preview-";
export declare const PreviewConfig: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    host: z.ZodDefault<z.ZodLiteral<"railway">>;
    project: z.ZodOptional<z.ZodString>;
    template_environment: z.ZodOptional<z.ZodString>;
    services: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>>>;
    url_service: z.ZodOptional<z.ZodString>;
    flows: z.ZodOptional<z.ZodArray<z.ZodString>>;
    max_concurrent: z.ZodDefault<z.ZodNumber>;
    timeout_s: z.ZodDefault<z.ZodNumber>;
    ttl_hours: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type PreviewConfig = z.infer<typeof PreviewConfig>;
export declare function previewPr(name: string): number | null;
