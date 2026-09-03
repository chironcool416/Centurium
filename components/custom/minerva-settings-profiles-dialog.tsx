'use client';

import { useState } from 'react';
import { Save, Trash2, Upload, RotateCcw } from 'lucide-react';
import { Localize } from '@deriv-com/translations';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppTranslations } from '@/components/custom/i18n-provider';

export interface RobotSettingsProfile<T> {
  name: string;
  savedAt: number;
  settings: T;
}

interface MinervaSettingsProfilesDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Profiles keyed by name, newest edits last. */
  profiles: Record<string, RobotSettingsProfile<T>>;
  /** Name of the profile that was most recently loaded/saved, if any — highlighted in the list. */
  activeProfileName: string | null;
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
}

/**
 * "Save settings" for Minerva used to silently overwrite a single blob in
 * localStorage — there was no way to keep more than one configuration
 * around. This dialog turns that into a small named-profile store: type a
 * name, save the current form under it, and come back later to reload it
 * exactly (or delete it) without touching whatever is currently on screen.
 */
export function MinervaSettingsProfilesDialog<T>({
  open,
  onOpenChange,
  profiles,
  activeProfileName,
  onSave,
  onLoad,
  onDelete,
}: MinervaSettingsProfilesDialogProps<T>) {
  const { localize } = useAppTranslations();
  const [newProfileName, setNewProfileName] = useState('');

  const profileList = Object.values(profiles).sort((a, b) => b.savedAt - a.savedAt);

  const handleSaveNew = () => {
    const name = newProfileName.trim();
    if (!name) return;
    onSave(name);
    setNewProfileName('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Localize i18n_default_text="Settings profiles" />
          </DialogTitle>
          <DialogDescription>
            <Localize i18n_default_text="Save the current settings under a name, then load any saved profile back exactly as it was." />
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="minerva-new-profile-name" className="text-xs">
              <Localize i18n_default_text="Profile name" />
            </Label>
            <Input
              id="minerva-new-profile-name"
              placeholder={localize('e.g. TRIAL 1')}
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSaveNew();
                }
              }}
              maxLength={60}
            />
          </div>
          <Button onClick={handleSaveNew} disabled={!newProfileName.trim()}>
            <Save className="h-4 w-4" />
            <Localize i18n_default_text="Save as new" />
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            <Localize i18n_default_text="Saved profiles" />
          </Label>

          {profileList.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              <Localize i18n_default_text="No profiles saved yet." />
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
              {profileList.map((profile) => {
                const isActive = profile.name === activeProfileName;
                return (
                  <div
                    key={profile.name}
                    className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${
                      isActive ? 'border-primary/60 bg-primary/5' : 'border-border'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{profile.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(profile.savedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onSave(profile.name)}
                        title={localize('Overwrite with current settings')}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => onLoad(profile.name)}
                        title={localize('Load this profile')}
                      >
                        <Upload className="h-3.5 w-3.5" />
                        <Localize i18n_default_text="Load" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => onDelete(profile.name)}
                        title={localize('Delete this profile')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
