// WHY: two agents editing one file at once end in a conflict fix; a running task owns its hotspot
// files and its plan's files, and a task that would change any of them waits until the owner ends.
// INVARIANT: a wait cycle between running tasks, or a claim with no live task, is reported and
// broken, never waited on.
import type { Hold } from './hotspots.js';

/** INVARIANT: plan paths are compared repo-relative, without "./" and surrounding blanks. */
export const normFiles = (files: readonly string[]) => [...new Set(files.map((f) => f.trim().replace(/^\.\//, '')).filter(Boolean))].sort();

export class FileClaims {
  private claims = new Map<number, Set<string>>();
  /** INVARIANT: a waiter waits on exactly one owner at a time; the edge is gone once it owns its files. */
  private waits = new Map<number, number>();

  set(issue: number, files: readonly string[]): void {
    this.claims.set(issue, new Set(normFiles(files)));
  }

  add(issue: number, files: readonly string[]): void {
    const s = this.claims.get(issue) ?? new Set<string>();
    for (const f of normFiles(files)) s.add(f);
    this.claims.set(issue, s);
  }

  release(issue: number): void {
    this.claims.delete(issue);
    this.waits.delete(issue);
  }

  files(issue: number): string[] {
    return [...(this.claims.get(issue) ?? [])].sort();
  }

  /** WHY: the shape pickDispatch takes, so a dispatch hold and an in-task hold judge overlap the same way. */
  running(): { issue: number; hotspots: string[] }[] {
    return [...this.claims].map(([issue, s]) => ({ issue, hotspots: [...s].sort() }));
  }

  /** INVARIANT: a task never clashes with itself; null means every file in `files` is free. */
  clash(issue: number, files: readonly string[]): Hold | null {
    const want = normFiles(files);
    for (const [other, owned] of this.claims) {
      if (other === issue) continue;
      const both = want.filter((f) => owned.has(f));
      if (both.length) return { issue, by: other, files: both };
    }
    return null;
  }

  wait(issue: number, on: number): void {
    this.waits.set(issue, on);
  }

  unwait(issue: number): void {
    this.waits.delete(issue);
  }

  /** INVARIANT: only a cycle through `issue` counts; one further along is found by its own members. */
  cycle(issue: number): number[] | null {
    const path = [issue];
    for (let n = this.waits.get(issue); n !== undefined; n = this.waits.get(n)) {
      if (n === issue) return path;
      if (path.includes(n)) return null;
      path.push(n);
    }
    return null;
  }

  /** WHY: a claim outliving its task would hold every overlapping task forever; each one is dropped and returned for the report. */
  dropStale(live: (issue: number) => boolean): { issue: number; files: string[] }[] {
    const out: { issue: number; files: string[] }[] = [];
    for (const issue of [...this.claims.keys()]) {
      if (live(issue)) continue;
      out.push({ issue, files: this.files(issue) });
      this.release(issue);
    }
    return out;
  }
}
