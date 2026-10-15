// WHY: every first-run screen can be run again later (owner direction): Settings lists each one with its state, the
// command or config key that does the same without the page, and a link that opens it on the first-run page.
import { useEffect, useState } from 'react';
import { getFirstRun, type SetupStepView } from '../api';
import { navigate } from '../App';
import { Badge, Card } from './ui';

/** The steps with a screen of their own: an action, a form, Start, or another page. */
export const withScreen = (steps: SetupStepView[]) => steps.filter((s) => ['action', 'form', 'start', 'screen', 'signin', 'gh-login', 'discord'].includes(s.fix.kind));

export function SetupScreensView({ steps }: { steps: SetupStepView[] }) {
  return (
    <Card className="overflow-hidden" data-testid="setup-screens">
      <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium text-ink">Setup screens</div>
      <ul className="divide-y divide-line">
        {steps.map((s) => (
          <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5" data-testid="setup-screen" data-step={s.id}>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
                {s.title}
                <Badge tone={s.done ? 'ok' : s.skipped ? 'neutral' : 'warn'}>{s.done ? 'done' : s.skipped ? 'skipped' : 'not done'}</Badge>
              </div>
              {s.automation && <div className="break-words font-mono text-[11.5px] text-ink-3">{s.automation}</div>}
            </div>
            <a
              href={`/first-run?step=${encodeURIComponent(s.id)}`}
              className="text-[12.5px] text-blue-ink hover:underline"
              onClick={(e) => (e.preventDefault(), navigate(`/first-run?step=${encodeURIComponent(s.id)}`))}
              data-testid="setup-screen-open"
            >
              {s.done ? 'Run again' : 'Open'}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * For owners and writers (the first-run checklist is theirs); nothing for anyone else. `onLoaded`: called once its
 * answer (the steps, or a refusal that shows nothing) is in, for the page's in-order panels.
 */
export function SetupScreens({ onLoaded }: { onLoaded?: () => void } = {}) {
  const [steps, setSteps] = useState<SetupStepView[] | null>(null);
  useEffect(() => {
    getFirstRun()
      .then((f) => setSteps(withScreen(f.setup?.groups.flatMap((g) => g.steps) ?? [])))
      .catch(() => setSteps(null))
      .finally(() => onLoaded?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return steps?.length ? <SetupScreensView steps={steps} /> : null;
}
