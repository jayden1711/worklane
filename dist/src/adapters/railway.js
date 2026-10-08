// Railway CLI adapter: which environment is a directory linked to?
// The CLI stores links in ~/.railway/config.json keyed by project path.
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homeDir } from '../os/index.js';
export function railwayLinkedEnvironment(cwd, configPath = join(homeDir(), '.railway', 'config.json')) {
    let projects;
    try {
        projects = JSON.parse(readFileSync(configPath, 'utf8')).projects ?? {};
    }
    catch {
        return null;
    }
    const dir = resolve(cwd);
    let best = null;
    for (const [path, link] of Object.entries(projects)) {
        const p = resolve(path);
        if ((dir === p || dir.startsWith(p + sep)) && (!best || p.length > best.len))
            best = { len: p.length, link };
    }
    return best?.link.environmentName ?? best?.link.environment ?? null;
}
//# sourceMappingURL=railway.js.map