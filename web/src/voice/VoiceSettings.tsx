// WHY: the voice switches sit on Settings for the instance's owners only, kept in this browser (prefs.ts).
import { useEffect, useState } from 'react';
import { onDevice, speechCtor, type Availability, type RecognitionCtor } from './speech';
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

export function VoiceSettingsView({ prefs, status, lang, onChange, onInstall, installing = false }: { prefs: VoicePrefs; status: OnDeviceStatus | null; lang: string; onChange: (p: VoicePrefs) => void; onInstall: () => void; installing?: boolean }) {
  return (
    <Card className="overflow-hidden" data-testid="settings-voice">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Voice dictation (this browser, owners only)</div>
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
  const lang = speechLang();
  useEffect(() => {
    if (owner) void statusOf(speechCtor(), lang).then(setStatus);
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
  return <VoiceSettingsView prefs={prefs} status={status} lang={lang} onChange={setPrefs} onInstall={() => void install()} installing={installing} />;
}
