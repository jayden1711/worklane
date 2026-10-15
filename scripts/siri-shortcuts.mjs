#!/usr/bin/env node
// The Siri Shortcuts' unsigned sources (docs/siri.md): shortcuts/tell.shortcut and shortcuts/ask.shortcut, written
// here as XML property lists, the same every time (fixed UUIDs), so a change to a Shortcut is a reviewed diff.
//
// They hold no address, token, name or contact: the hub's Siri address and the device token are import questions,
// answered on the phone when the Shortcut is added (Apple: "that field is cleared when the shortcut is shared";
// https://support.apple.com/guide/shortcuts/apdf330fd3a0/ios). test/siri-shortcuts.test.ts checks both.
//
// iOS imports only signed Shortcuts, and signing needs a Mac and Apple (shortcuts sign), so the owner signs these
// once on a Mac and again only when one changes (docs/siri.md has the command).
//
//   node scripts/siri-shortcuts.mjs           write both files
//   node scripts/siri-shortcuts.mjs --check   exit 1 when the files differ from what this writes
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OBJ = '￼';

// ---------------------------------------------------------------- a property list, as XML

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist(v, pad = '') {
  if (v === true) return `${pad}<true/>`;
  if (v === false) return `${pad}<false/>`;
  if (typeof v === 'number') return `${pad}<integer>${v}</integer>`;
  if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>`;
  if (Array.isArray(v)) return v.length ? `${pad}<array>\n${v.map((x) => plist(x, `${pad}\t`)).join('\n')}\n${pad}</array>` : `${pad}<array/>`;
  const keys = Object.keys(v);
  return keys.length ? `${pad}<dict>\n${keys.map((k) => `${pad}\t<key>${esc(k)}</key>\n${plist(v[k], `${pad}\t`)}`).join('\n')}\n${pad}</dict>` : `${pad}<dict/>`;
}
const document = (v) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plist(v)}\n</plist>\n`;

// ---------------------------------------------------------------- Shortcuts' building blocks

const out = (uuid, name) => ({ OutputName: name, OutputUUID: uuid, Type: 'ActionOutput' });
const variable = (name) => ({ Type: 'Variable', VariableName: name });
/** Text with variables in it: `parts` are strings and attachments, in order. */
function text(...parts) {
  let s = '';
  const at = {};
  for (const p of parts) {
    if (typeof p === 'string') s += p;
    else {
      at[`{${s.length}, 1}`] = p;
      s += OBJ;
    }
  }
  return { Value: { attachmentsByRange: at, string: s }, WFSerializationType: 'WFTextTokenString' };
}
const attachment = (a) => ({ Value: a, WFSerializationType: 'WFTextTokenAttachment' });
const dictionary = (items) => ({ Value: { WFDictionaryFieldValueItems: items.map(([k, v]) => ({ WFItemType: 0, WFKey: text(k), WFValue: v })) }, WFSerializationType: 'WFDictionaryFieldValue' });
const action = (id, params) => ({ WFWorkflowActionIdentifier: id, WFWorkflowActionParameters: params });

const TOKEN_UUID = '6C1D1E0A-0001-4A11-8000-000000000001';
const URL_UUID = '6C1D1E0A-0002-4A11-8000-000000000002';
const SAID_UUID = '6C1D1E0A-0003-4A11-8000-000000000003';
const POST_UUID = '6C1D1E0A-0004-4A11-8000-000000000004';
const ID_UUID = '6C1D1E0A-0005-4A11-8000-000000000005';
const GET_UUID = '6C1D1E0A-0006-4A11-8000-000000000006';
const SPEECH_UUID = '6C1D1E0A-0007-4A11-8000-000000000007';
const REPEAT_GROUP = '6C1D1E0A-0008-4A11-8000-000000000008';

/** The two answers asked when the Shortcut is added: the device token, then the hub's Siri address. Never in the file. */
const setup = [
  action('is.workflow.actions.gettext', { UUID: TOKEN_UUID, WFTextActionText: '' }),
  action('is.workflow.actions.gettext', { UUID: URL_UUID, WFTextActionText: '' }),
];
const questions = [
  { ActionIndex: 0, Category: 'Parameter', DefaultValue: '', ParameterKey: 'WFTextActionText', Text: 'The device token for this phone (the dashboard: Settings, Siri devices, New token; shown once)' },
  { ActionIndex: 1, Category: 'Parameter', DefaultValue: '', ParameterKey: 'WFTextActionText', Text: "The hub's Siri address: your machine's tailnet name with https, ending in :8443 (no slash at the end)" },
];
const headers = dictionary([['Authorization', text('Bearer ', out(TOKEN_UUID, 'Text'))]]);
const said = (prompt) => action('is.workflow.actions.ask', { UUID: SAID_UUID, WFAskActionPrompt: prompt, WFInputType: 'Text' });
const post = (path) =>
  action('is.workflow.actions.downloadurl', {
    UUID: POST_UUID,
    WFURL: text(out(URL_UUID, 'Text'), path),
    WFHTTPMethod: 'POST',
    ShowHeaders: true,
    WFHTTPHeaders: headers,
    WFHTTPBodyType: 'JSON',
    WFJSONValues: dictionary([['text', text(out(SAID_UUID, 'Provided Input'))]]),
  });
const valueOf = (uuid, input, key) => action('is.workflow.actions.getvalueforkey', { UUID: uuid, WFGetDictionaryValueType: 'Value', WFDictionaryKey: key, WFInput: attachment(input) });
const speak = (input) => action('is.workflow.actions.speaktext', { WFText: text(input) });

function shortcut(actions) {
  return {
    WFWorkflowClientVersion: '2302.0.4',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 59511, WFWorkflowIconStartColor: 463140863 },
    WFWorkflowTypes: [],
    WFWorkflowInputContentItemClasses: [],
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowHasOutputFallback: false,
    WFWorkflowImportQuestions: questions,
    WFWorkflowActions: actions,
  };
}

/** "Hey Siri, tell <product>": the idea, posted to /tell; Siri says what came back. */
export const TELL = shortcut([...setup, said('What should I tell it?'), post('/tell'), valueOf(SPEECH_UUID, out(POST_UUID, 'Contents of URL'), 'speech'), speak(out(SPEECH_UUID, 'Dictionary Value'))]);

/**
 * "Hey Siri, ask <product>": the question, posted to /ask (which answers within 8 s, or says it is still thinking), then
 * asked again by its id up to 6 times (each waits up to 8 s; an answered one comes back at once). Siri says the last.
 */
export const ASK = shortcut([
  ...setup,
  said('What do you want to ask?'),
  post('/ask'),
  action('is.workflow.actions.setvariable', { WFVariableName: 'answer', WFInput: attachment(out(POST_UUID, 'Contents of URL')) }),
  valueOf(ID_UUID, out(POST_UUID, 'Contents of URL'), 'id'),
  action('is.workflow.actions.repeat.count', { GroupingIdentifier: REPEAT_GROUP, WFControlFlowMode: 0, WFRepeatCount: 6 }),
  action('is.workflow.actions.downloadurl', { UUID: GET_UUID, WFURL: text(out(URL_UUID, 'Text'), '/ask/', out(ID_UUID, 'Dictionary Value')), WFHTTPMethod: 'GET', ShowHeaders: true, WFHTTPHeaders: headers }),
  action('is.workflow.actions.setvariable', { WFVariableName: 'answer', WFInput: attachment(out(GET_UUID, 'Contents of URL')) }),
  action('is.workflow.actions.repeat.count', { GroupingIdentifier: REPEAT_GROUP, WFControlFlowMode: 2 }),
  valueOf(SPEECH_UUID, variable('answer'), 'speech'),
  speak(out(SPEECH_UUID, 'Dictionary Value')),
]);

export const FILES = { 'shortcuts/tell.shortcut': document(TELL), 'shortcuts/ask.shortcut': document(ASK) };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [rel, body] of Object.entries(FILES)) {
    const f = join(root, rel);
    if (check) {
      let have = '';
      try {
        have = readFileSync(f, 'utf8');
      } catch {
        // missing: stale
      }
      if (have !== body) {
        console.error(`${rel} isn't what scripts/siri-shortcuts.mjs writes: run it`);
        stale++;
      }
    } else {
      writeFileSync(f, body);
      console.log(`wrote ${rel}`);
    }
  }
  process.exit(stale ? 1 : 0);
}
