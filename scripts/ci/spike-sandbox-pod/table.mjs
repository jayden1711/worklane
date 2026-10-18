// SPIKE (do not merge), #698 decision 5. Reads run.sh's logs (<out>/<pass>/<n>.log: INFO and RESULT lines) and
// prints one markdown table per pass, to stdout and to the job summary. Usage: node table.mjs <out>
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
const COLS = [
  ['unshare_user', 'unshare -U'],
  ['unshare_user_mount', 'unshare -Ur -m'],
  ['unshare_fresh_proc', 'unshare fresh /proc'],
  ['bwrap_srt_flags', 'bwrap, srt flags (--proc)'],
  ['bwrap_weaker_proc', 'bwrap, weaker (--bind /proc)'],
  ['net_outside', 'net from pod'],
  ['net_isolated_bwrap_fresh', 'net blocked in bwrap'],
  ['net_isolated_bwrap_weaker', 'net blocked in bwrap (weaker)'],
  ['srt_true', 'srt trivial cmd'],
  ['srt_net_blocked', 'srt net blocked'],
  ['srt_deny_read', 'srt denyRead holds'],
  ['srt_weaker', 'srt, enableWeakerNestedSandbox'],
  ['fail_closed', 'fail-closed'],
];

const parse = (text) => {
  const info = {};
  const res = {};
  for (const l of text.split('\n')) {
    const f = l.split('|');
    if (f[0] === 'INFO') info[f[1]] = f.slice(2).join('|');
    if (f[0] === 'RESULT') res[f[1]] = { v: f[2], d: f.slice(3).join('|') };
  }
  return { info, res };
};
const seccompOf = (s = '') => ({ 0: 'none', 1: 'strict', 2: 'filter' })[/Seccomp: (\d)/.exec(s)?.[1]] ?? '?';
const usernsOf = (m = '') => (/^\s*0\s+0\s+4294967295/.test(m) ? 'host' : m ? 'own' : '?');

let md = '';
const passes = readdirSync(out).filter((d) => statSync(join(out, d)).isDirectory() && /^aa-|^host/.test(d)).sort();
for (const pass of passes) {
  const dir = join(out, pass);
  const files = readdirSync(dir).filter((f) => f.endsWith('.log')).sort((a, b) => parseInt(a) - parseInt(b));
  md += `\n### Pass: ${pass}\n\n`;
  md += `| profile | admitted under | seccomp | AppArmor | userns | ${COLS.map(([, h]) => h).join(' | ')} |\n`;
  md += `|${'---|'.repeat(COLS.length + 5)}\n`;
  const notes = [];
  for (const f of files) {
    const { info, res } = parse(readFileSync(join(dir, f), 'utf8'));
    const ran = info.phase === 'Succeeded' && 'fail_closed' in res;
    const cells = COLS.map(([k]) => (ran ? (res[k]?.v ?? '?') : '-'));
    md += `| ${info.profile} | ${info.admitted ?? '?'} | ${ran ? seccompOf(info.status) : '-'} | ${ran ? (info.apparmor ?? '?').trim() : '-'} | ${ran ? usernsOf(info.uid_map) : '-'} | ${cells.join(' | ')} |\n`;
    if (info.admitted === 'none' || (info.denied ?? '').trim()) notes.push(`- ${info.profile}: refused by admission: ${(info.denied ?? '').slice(0, 400)}`);
    if (info.admitted !== 'none' && !ran) notes.push(`- ${info.profile}: pod didn't run the probe (phase ${info.phase || 'none'}): ${(info.why ?? '').slice(0, 400)}`);
    for (const k of ['bwrap_srt_flags', 'srt_true', 'unshare_user', 'unshare_fresh_proc']) {
      if (ran && res[k] && res[k].v !== 'yes') notes.push(`- ${info.profile} / ${k}: ${res[k].d.slice(0, 300)}`);
    }
  }
  if (notes.length) md += `\nWhy (first words of each failure):\n\n${notes.join('\n')}\n`;
}
const host = join(out, 'host.txt');
if (existsSync(host)) md = `### Runner\n\n\`\`\`\n${readFileSync(host, 'utf8').trim()}\n\`\`\`\n${md}`;
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Sandbox in a restricted pod (#698 decision 5)\n${md}`);
