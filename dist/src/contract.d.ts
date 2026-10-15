import { z } from 'zod';
/** `- browser: checkout` runs the app's `checkout` flow in a real browser and judges it (src/browser/check.ts). */
export declare const BrowserDoneWhenItem: z.ZodObject<{
    browser: z.ZodString;
}, z.core.$strict>;
export type BrowserDoneWhenItem = z.infer<typeof BrowserDoneWhenItem>;
export declare const DoneWhen: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
    command: z.ZodString;
    timeout_s: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    test: z.ZodString;
    timeout_s: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    suite: z.ZodEnum<{
        changed: "changed";
        full: "full";
    }>;
    timeout_s: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    manual: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    repro: z.ZodBoolean;
}, z.core.$strict>, z.ZodObject<{
    browser: z.ZodString;
}, z.core.$strict>]>>;
export declare const TaskFile: z.ZodObject<{
    id: z.ZodString;
    done_when: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        command: z.ZodString;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        test: z.ZodString;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        suite: z.ZodEnum<{
            changed: "changed";
            full: "full";
        }>;
        timeout_s: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>, z.ZodObject<{
        manual: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        repro: z.ZodBoolean;
    }, z.core.$strict>, z.ZodObject<{
        browser: z.ZodString;
    }, z.core.$strict>]>>;
    frozen: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export type TaskFile = z.infer<typeof TaskFile>;
