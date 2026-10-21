// OS adapter: names whose meaning depends on the process that reads them. WHY (#972): the tool guard resolves a path
// in its own process, so a name that means "the reading process's folder" would lead it to its own folder, not the
// folder of the tool that acts on the path; such a name can't be judged there, and the guard refuses it.

/**
 * Whether `p` is a link to the reading process's own working or root folder: Linux's /proc/<own pid>/cwd and root (a
 * thread's under task/ too; /proc/self and /proc/thread-self lead to these). False on every other system.
 */
export function ownFolderLink(p: string): boolean {
  if (process.platform !== 'linux') return false;
  return new RegExp(`^/proc/${process.pid}/(task/\\d+/)?(cwd|root)$`).test(p);
}
