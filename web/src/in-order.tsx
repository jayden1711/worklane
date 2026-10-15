// Panels on one page that each load their own data (the Machine page's), shown in page order: a
// panel is shown once every panel above it has had its first answer (its data, an error it shows, or a refusal that
// hides it). So nothing that loads late ever appears above something already on screen, and a press aimed at a
// button never lands on a panel that moved in above it (test/machine-no-shift.test.ts). Every panel mounts, and asks
// for its data, at once: only showing waits, so the page takes as long as its slowest answer, never the sum.
//
// Each panel is a function of its `loaded` callback, which it calls once its first answer is in (more calls are
// fine). The wrapper is `display: contents` while shown and `display: none` before, so the panels lay out as the
// container's own children (use a flex or grid container with a gap: a hidden or empty panel takes no gap).
// `data-loaded="true"` on the wrapper says every panel has answered (what the real-Chrome tests wait for).
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type PanelLoaded = () => void;

export function InOrder({ panels, testId }: { panels: ((loaded: PanelLoaded) => ReactNode)[]; testId: string }) {
  const [done, setDone] = useState<boolean[]>(() => panels.map(() => false));
  // One callback per panel for the page's life, so a panel's effects never run again for a new one.
  const marks = useRef<PanelLoaded[]>([]);
  for (let i = 0; i < panels.length; i++) marks.current[i] ??= () => setDone((d) => (d[i] ? d : d.map((x, j) => x || j === i)));
  // The first panel still waiting for its answer: it and every panel above it are shown; those below it wait.
  const first = done.indexOf(false);
  const upTo = first === -1 ? panels.length : first;
  // A link to a panel further down (/machine#tailscale) lands on it once it is shown.
  const scrolled = useRef(false);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (scrolled.current || !id) return;
    const el = document.getElementById(id);
    if (el?.closest('[data-in-order-panel="shown"]')) {
      scrolled.current = true;
      el.scrollIntoView({ block: 'start' });
    }
  }, [upTo]);
  return (
    <div className="contents" data-testid={testId} data-loaded={upTo === panels.length ? 'true' : 'false'}>
      {panels.map((panel, i) => (
        <div key={i} className={i <= upTo ? 'contents' : 'hidden'} data-in-order-panel={i <= upTo ? 'shown' : 'waiting'}>
          {panel(marks.current[i]!)}
        </div>
      ))}
      {upTo < panels.length ? (
        <p className="text-[12.5px] text-ink-3" role="status" data-testid={`${testId}-loading`}>
          Loading…
        </p>
      ) : null}
    </div>
  );
}
