// The merge gate's coverage reader, as a process of its own (#784 round 4). The coverage directory and the files
// around it are written by the PR's code, and reading them is synchronous work (a script URL through a deep path, a
// large map): run here, the coordinator's thread never waits on it, and readTouchedInChild (src/vacuity.ts) kills it
// past its time limit. It reads one request (TouchedRequest) on stdin and writes one answer on stdout: the touched
// files, or why it couldn't read them, as fixed text (CoverageUnreadable's), never a file's content.
import { baseTextReader, CoverageUnreadable, measureTouched, type TouchedAnswer, type TouchedRequest } from './vacuity.js';

const MAX_REQUEST = 4 * 1024 * 1024;

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  raw += chunk as string;
  if (raw.length > MAX_REQUEST) break;
}
let answer: TouchedAnswer;
try {
  if (raw.length > MAX_REQUEST) throw new CoverageUnreadable('the coverage read was asked too much');
  const req = JSON.parse(raw) as TouchedRequest;
  // Removed lines are lexed only in their base file (round 11): a request without the base or the clone is refused.
  if (typeof req.base !== 'string' || !req.base || typeof req.repo !== 'string' || !req.repo) throw new CoverageUnreadable('the coverage read was asked without the base to read removed lines in');
  answer = measureTouched(req.coverageDir, req.root, req.appPaths, req.only, req.hunks, req.baselineDir, req.loads ?? [], baseTextReader(req.repo, req.base), req.elsewhere ?? {});
} catch (e) {
  answer = { error: e instanceof CoverageUnreadable ? e.message : 'the coverage read failed' };
}
process.stdout.write(JSON.stringify(answer));
