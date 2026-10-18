// SPIKE (do not merge), #698 decision 5. Prints the shell string sandbox-runtime itself builds for `true` under the
// given settings file (the exact bwrap argv srt runs), so the log shows the flags the probe copies. Runs nothing.
// Usage: node wrap.mjs <settings.json>
import { readFileSync } from 'node:fs';
import { SandboxManager, SandboxRuntimeConfigSchema } from '/opt/srt/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js';

const config = SandboxRuntimeConfigSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
try {
  await SandboxManager.initialize(config);
  console.log(await SandboxManager.wrapWithSandbox('true'));
} catch (e) {
  console.log(`wrap failed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await SandboxManager.reset();
}
