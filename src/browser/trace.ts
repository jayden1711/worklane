// A performance trace's summary for a browser check: long tasks on the page's main thread, and the share of
// frames dropped. Pure: from Chrome's trace events (the Tracing domain's dataCollected), nothing else.

/** The categories a browser check traces: main-thread tasks, and the frame pipeline. */
export const TRACE_CATEGORIES = ['__metadata', 'toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'benchmark', 'graphics.pipeline'];

/** A main-thread task at least this long counts as a long task (the web's own definition). */
export const LONG_TASK_MS = 50;

export interface TraceEvent {
  name?: string;
  ph?: string;
  pid?: number;
  tid?: number;
  dur?: number;
  args?: Record<string, unknown>;
}

export interface TraceSummary {
  /** Main-thread tasks of LONG_TASK_MS or more. */
  longTasks: number;
  /** The longest main-thread task, in ms (0 when there was none). */
  maxTaskMs: number;
  /** The share of frames dropped, 0-100; null when the trace has no frame events to judge by. */
  droppedFramePct: number | null;
  frames: number;
}

export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  // The renderer's main thread(s): named CrRendererMain in the trace's metadata.
  const main = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && (e.args?.name as string | undefined) === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  let longTasks = 0;
  let maxTaskMs = 0;
  for (const e of events) {
    if (e.name !== 'RunTask' || e.ph !== 'X' || typeof e.dur !== 'number' || !main.has(`${e.pid}:${e.tid}`)) continue;
    const ms = e.dur / 1000;
    maxTaskMs = Math.max(maxTaskMs, ms);
    if (ms >= LONG_TASK_MS) longTasks++;
  }
  // Frames: each PipelineReporter slice is one frame, its state presented or dropped.
  const states = events.filter((e) => e.name === 'PipelineReporter' && e.ph !== 'e').map((e) => ((e.args?.chrome_frame_reporter as { state?: string } | undefined)?.state ?? '')).filter(Boolean);
  const dropped = states.filter((s) => s === 'STATE_DROPPED').length;
  return { longTasks, maxTaskMs: Math.round(maxTaskMs), droppedFramePct: states.length ? Math.round((dropped / states.length) * 1000) / 10 : null, frames: states.length };
}
