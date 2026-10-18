// The chat's model and effort picker (src/chat-pick.ts): the models are only those the instance's agents.yaml routing
// names that this person may pick (the owner any; a writer those at or below the default's price tier), the efforts a
// fixed list. A viewer never sees it. Unset means routing's default model and the CLI's default effort. The server
// checks every pick again before the answer runs, and refuses it once the conversation's cap is spent.
import { useEffect, useState } from 'react';
import { chatPickerOptions, type ChatPick, type ChatPickerOptions } from '../api';

const field = 'h-6 rounded-control bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--ring)]';

/** The picker's options for the instance asked (null: this page's own); none while loading, on error or for a viewer. */
export function useChatPicker(instance: string | null, active: boolean): ChatPickerOptions | null {
  const [o, setO] = useState<ChatPickerOptions | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setO(null);
    chatPickerOptions(instance)
      .then((x) => live && setO(x))
      .catch(() => live && setO(null));
    return () => {
      live = false;
    };
  }, [instance, active]);
  return o;
}

export function ChatPicker({ options, value, onChange }: { options: ChatPickerOptions | null; value: ChatPick; onChange: (p: ChatPick) => void }) {
  if (!options?.canPick) return null;
  const set = (k: keyof ChatPick, v: string) => {
    const next: ChatPick = { ...value };
    if (v) Object.assign(next, { [k]: v });
    else delete next[k];
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3" data-testid="chat-picker">
      <label className="flex items-center gap-1">
        Model
        <select className={field} value={value.model ?? ''} onChange={(e) => set('model', e.target.value)} data-testid="chat-pick-model">
          <option value="">{options.defaultModel} (default)</option>
          {options.models
            .filter((m) => m !== options.defaultModel)
            .map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Effort
        <select className={field} value={value.effort ?? ''} onChange={(e) => set('effort', e.target.value)} data-testid="chat-pick-effort">
          <option value="">default</option>
          {options.efforts.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      <span data-testid="chat-pick-cap">cap ${options.capUsd} a conversation</span>
    </div>
  );
}
