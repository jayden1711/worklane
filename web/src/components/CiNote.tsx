// WHY (#469): under No CI (config.yaml ci: none) GitHub runs nothing a PR waits on: the PR, land and Settings pages
// say what judges a PR instead, so nobody reads an absent GitHub check as "nothing to wait for".
import type { CiMode } from '../api';

export function CiNote({ ci }: { ci: CiMode | undefined }) {
  if (ci?.kind !== 'none' || !ci.means) return null;
  return (
    <p className="mx-6 mt-4 rounded-lg bg-blue-tint px-3 py-2 text-[12.5px] text-ink" data-testid="ci-none-note">
      {ci.means}. The main watch can't judge merges by checks; auto-merge relies on this machine's runs.
    </p>
  );
}
