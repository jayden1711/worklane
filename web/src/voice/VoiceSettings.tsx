// WHY: the voice switches sit on Settings for the instance's owners only, kept in this browser (prefs.ts).
import { useEffect, useState } from 'react';
import { onDevice, speechCtor, type Availability, type RecognitionCtor } from './speech';
import { synthOf, type Voice } from './talk';
import { speechLang, useVoicePrefs, type VoicePrefs } from './prefs';
import { Button, Card } from '../components/ui';

/** What on-device recognition is here: no recognizer, no on-device API (null), or its availability. */
export type OnDeviceStatus = { recognizer: false } | { recognizer: true; availability: Availability | null };

const STATUS: Record<Availability, string> = {
  available: 'available: dictation stays on this computer',
  downloadable: "not downloaded yet: the browser can fetch the language model (the audio still isn't sent)",
  downloading: 'downloading',
  unavailable: "not available for this language in this browser",
};

const TOGGLE = 'flex cursor-pointer items-start gap-2.5 px-4 py-2.5 text-[13px]';

/** The browser's voices for the language: null with no speech synthesis at all. */
export type VoiceCount = { local: number; network: number } | null;

export function countVoices(voices: readonly Voice[], lang: string): { local: number; network: number } {
  const base = lang.split('-')[0]!.toLowerCase();
  const mine = voices.filter((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base);
  return { local: mine.filter((v) => v.localService === true).length, network: mine.filter((v) => v.localService !== true).length };
}

function voicesLine(c: VoiceCount | undefined, allowNetwork: boolean): string {
  if (c === undefined) return 'checking…';
  if (c === null) return "this browser can't read aloud";
  const local = `${c.local} on-device`;
  if (!c.local && !allowNetwork) return `${local}${c.network ? ` (${c.network} network, not used)` : ''}: answers aren't read aloud here`;
  return `${local}${c.network ? `, ${c.network} network${allowNetwork ? '' : ' (not used)'}` : ''}`;
}

export function VoiceSettingsView({ prefs, status, lang, onChange, onInstall, installing = false, voices }: { prefs: VoicePrefs; status: OnDeviceStatus | null; lang: string; onChange: (p: VoicePrefs) => void; onInstall: () => void; installing?: boolean; voices?: VoiceCount }) {
  return (
    <Card className="overflow-hidden" data-testid="settings-voice">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Voice (this browser, owners only)</div>
      <div className="divide-y divide-line">
        <label className={TOGGLE}>
          <input type="checkbox" className="mt-0.5" checked={prefs.dictation} onChange={(e) => onChange({ ...prefs, dictation: e.target.checked })} data-testid="voice-dictation" />
          <span className="min-w-0">
            <span className="block text-ink">Mic button in the Ask panel</span>
            <span className="block text-[12px] text-ink-3">Dictates into the question box for you to review; it never sends. Off by default.</span>
          </span>
        </label>
        <label className={TOGGLE}>
          <input type="checkbox" className="mt-0.5" checked={prefs.allowCloud} onChange={(e) => onChange({ ...prefs, allowCloud: e.target.checked })} data-testid="voice-allow-cloud" />
          <span className="min-w-0">
            <span className="block text-ink">Allow cloud recognition when on-device isn't available</span>
            <span className="block text-[12px] text-ink-3">Off: on-device only. On: the browser may send your audio to its speech service (in Chrome, Google's). Never to this dashboard's server.</span>
          </span>
        </label>
        <div className="px-4 py-2.5 text-[12.5px] text-ink-2" data-testid="voice-on-device">
          On-device recognition ({lang}):{' '}
          {!status ? 'checking…' : !status.recognizer ? 'this browser has no speech recognition' : status.availability === null ? "this browser can't recognize on-device" : STATUS[status.availability]}
          {status?.recognizer && status.availability === 'downloadable' && (
            <Button size="sm" variant="outline" className="ml-2" disabled={installing} onClick={onInstall} data-testid="voice-install">
              {installing ? 'Downloading…' : 'Download it'}
            </Button>
          )}
        </div>
        <label className={TOGGLE}>
          <input type="checkbox" className="mt-0.5" checked={prefs.talkBack} onChange={(e) => onChange({ ...prefs, talkBack: e.target.checked })} data-testid="voice-talk-back" />
          <span className="min-w-0">
            <span className="block text-ink">Read answers aloud in the Ask panel</span>
            <span className="block text-[12px] text-ink-3">The browser reads each new answer: code blocks and anything secret-shaped are left out. Talking, Esc, closing the panel or a new question stops it. Off by default.</span>
          </span>
        </label>
        <label className={TOGGLE}>
          <input type="checkbox" className="mt-0.5" checked={prefs.allowNetworkVoices} onChange={(e) => onChange({ ...prefs, allowNetworkVoices: e.target.checked })} data-testid="voice-allow-network-voices" />
          <span className="min-w-0">
            <span className="block text-ink">Allow network voices</span>
            <span className="block text-[12px] text-ink-3">Off: on-device voices only. On: the browser may use a voice that sends the answer's text to its vendor (in Chrome, the Google voices). Never to this dashboard's server.</span>
          </span>
        </label>
        <div className="px-4 py-2.5 text-[12.5px] text-ink-2" data-testid="voice-voices">
          Voices for reading aloud ({lang}): {voicesLine(voices, prefs.allowNetworkVoices)}
        </div>
      </div>
    </Card>
  );
}

async function statusOf(ctor: RecognitionCtor | null, lang: string): Promise<OnDeviceStatus> {
  return ctor ? { recognizer: true, availability: await onDevice(ctor, lang) } : { recognizer: false };
}

/** The section, for an owner only; anyone else gets nothing. */
export function VoiceSettings({ owner }: { owner: boolean }) {
  const [prefs, setPrefs] = useVoicePrefs();
  const [status, setStatus] = useState<OnDeviceStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [voices, setVoices] = useState<VoiceCount | undefined>(undefined);
  const lang = speechLang();
  useEffect(() => {
    if (owner) void statusOf(speechCtor(), lang).then(setStatus);
  }, [owner, lang]);
  useEffect(() => {
    if (!owner) return;
    const s = synthOf();
    if (!s) return setVoices(null);
    // WHY: Chrome lists its voices only after `voiceschanged`.
    const read = () => setVoices(countVoices(s.synth.getVoices(), lang));
    read();
    s.synth.addEventListener?.('voiceschanged', read);
    return () => s.synth.removeEventListener?.('voiceschanged', read);
  }, [owner, lang]);
  if (!owner) return null;
  const install = async () => {
    const ctor = speechCtor();
    if (!ctor?.install) return;
    setInstalling(true);
    try {
      await ctor.install({ langs: [lang], processLocally: true });
    } catch {
      // WHY: a refused or failed download leaves the status as the browser reports it next.
    }
    setInstalling(false);
    setStatus(await statusOf(ctor, lang));
  };
  return <VoiceSettingsView prefs={prefs} status={status} lang={lang} onChange={setPrefs} onInstall={() => void install()} installing={installing} voices={voices} />;
}
