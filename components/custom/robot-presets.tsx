'use client';

import { useEffect, useState } from 'react';
import { Bookmark, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Localize } from '@deriv-com/translations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAppTranslations } from '@/components/custom/i18n-provider';

const PRESETS_STORAGE_KEY = 'centurium:robot-presets';
const MAX_NAME_LENGTH = 40;

export type PresetBotMode = 'martingale' | 'ra' | 'differ' | 'mm';

const MODE_LABELS: Record<PresetBotMode, string> = {
  martingale: 'Martingale',
  ra: 'Ra',
  differ: 'Differ',
  mm: 'MM',
};

export interface RobotPreset<T> {
  id: string;
  name: string;
  savedAt: number;
  /** Which bot mode was selected when the preset was saved. */
  botMode: PresetBotMode;
  settings: T;
}

interface Props<T extends object> {
  /** Currently selected bot mode (saved with the preset). */
  botMode: PresetBotMode;
  /** Snapshot of every robot setting as it is right now. */
  collect: () => T;
  /** Apply a preset to the panel. */
  onLoad: (preset: RobotPreset<T>) => void;
  /** Loading is blocked while a robot is running. */
  loadDisabled: boolean;
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readPresets<T>(): RobotPreset<T>[] {
  try {
    const raw = window.localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is RobotPreset<T> =>
        !!p &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.savedAt === 'number' &&
        typeof p.settings === 'object' &&
        p.settings !== null &&
        p.botMode in MODE_LABELS
    );
  } catch {
    return [];
  }
}

/**
 * Named sets of robot settings. The plain "Save settings" button keeps working
 * as before (it's what the panel reloads on page open); presets sit beside it
 * so several setups can be kept and switched between by name. Stored in this
 * browser only (localStorage).
 */
export function RobotPresets<T extends object>({ botMode, collect, onLoad, loadDisabled }: Props<T>) {
  const { localize } = useAppTranslations();
  const [presets, setPresets] = useState<RobotPreset<T>[]>([]);
  const [draft, setDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setPresets(readPresets<T>());
  }, []);

  const persist = (next: RobotPreset<T>[]): boolean => {
    try {
      window.localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(next));
      setPresets(next);
      return true;
    } catch {
      toast.error(localize('Could not save presets on this device.'));
      return false;
    }
  };

  const saveAs = () => {
    const name = draft.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
      toast.error(localize('Give the preset a name first.'));
      return;
    }
    const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const entry: RobotPreset<T> = {
      id: existing?.id ?? newId(),
      name: existing?.name ?? name,
      savedAt: Date.now(),
      botMode,
      settings: collect(),
    };
    const next = existing
      ? presets.map((p) => (p.id === existing.id ? entry : p))
      : [...presets, entry];
    if (persist(next)) {
      setDraft('');
      toast.success(existing ? localize('Preset updated') : localize('Preset saved'), {
        description: entry.name,
      });
    }
  };

  const overwrite = (preset: RobotPreset<T>) => {
    const next = presets.map((p) =>
      p.id === preset.id ? { ...p, savedAt: Date.now(), botMode, settings: collect() } : p
    );
    if (persist(next)) toast.success(localize('Preset updated'), { description: preset.name });
  };

  const remove = (preset: RobotPreset<T>) => {
    if (confirmDeleteId !== preset.id) {
      setConfirmDeleteId(preset.id);
      return;
    }
    setConfirmDeleteId(null);
    if (persist(presets.filter((p) => p.id !== preset.id))) {
      toast.info(localize('Preset deleted'), { description: preset.name });
    }
  };

  const nameTaken = presets.some((p) => p.name.toLowerCase() === draft.trim().toLowerCase());

  return (
    <Popover onOpenChange={(open) => !open && setConfirmDeleteId(null)}>
      <PopoverTrigger asChild>
        <Button className="flex-1" variant="outline">
          <Bookmark className="mr-1.5 h-4 w-4" />
          <Localize i18n_default_text="Presets" />
          {presets.length > 0 && (
            <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] font-bold tabular-nums">
              {presets.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 space-y-3">
        <div className="space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-wide">
            <Localize i18n_default_text="Save current settings as" />
          </p>
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAs();
              }}
              placeholder={localize('Preset name')}
              maxLength={MAX_NAME_LENGTH}
            />
            <Button onClick={saveAs} className="shrink-0">
              {nameTaken ? <Localize i18n_default_text="Update" /> : <Localize i18n_default_text="Save" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            <Localize i18n_default_text="Saves every mode's settings plus the selected mode. Using an existing name updates that preset." />
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-bold uppercase tracking-wide">
            <Localize i18n_default_text="Saved presets" />
          </p>
          {presets.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              <Localize i18n_default_text="No presets yet." />
            </p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">{preset.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {MODE_LABELS[preset.botMode]} · {new Date(preset.savedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={loadDisabled}
                    title={loadDisabled ? localize('Stop the robot to load a preset') : undefined}
                    onClick={() => onLoad(preset)}
                  >
                    <Localize i18n_default_text="Load" />
                  </Button>
                  <button
                    type="button"
                    title={localize('Overwrite with the current settings')}
                    aria-label={localize('Overwrite with the current settings')}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/70 hover:bg-muted hover:text-foreground"
                    onClick={() => overwrite(preset)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title={
                      confirmDeleteId === preset.id
                        ? localize('Click again to delete')
                        : localize('Delete preset')
                    }
                    aria-label={localize('Delete preset')}
                    className={cn(
                      'flex h-7 items-center justify-center rounded-md px-1.5 hover:bg-muted',
                      confirmDeleteId === preset.id
                        ? 'bg-rose-500/15 text-rose-400 text-[10px] font-bold'
                        : 'w-7 text-foreground/70 hover:text-foreground'
                    )}
                    onClick={() => remove(preset)}
                  >
                    {confirmDeleteId === preset.id ? (
                      <Localize i18n_default_text="Sure?" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
