'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldDescription, FieldLabel, FieldLegend } from '@/components/ui/field';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ALL_FORMS, type DiscordConnection } from '@/lib/apps/discord/types';
import type { FormSummary } from '@/types';

interface DiscordSettingsProps {
  onConnectionChange: (connected: boolean) => void;
}

const WEBHOOK_URL_PATTERN = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

function formLabel(formId: string): string {
  return formId === ALL_FORMS ? 'All forms' : formId;
}

/**
 * Discord app: channels (webhooks) that get a message for each form submission
 */
export default function DiscordSettings({ onConnectionChange }: DiscordSettingsProps) {
  const [connections, setConnections] = useState<DiscordConnection[]>([]);
  const [forms, setForms] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [formId, setFormId] = useState<string>(ALL_FORMS);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [connectionToDelete, setConnectionToDelete] = useState<DiscordConnection | null>(null);

  const urlIsValid = WEBHOOK_URL_PATTERN.test(webhookUrl.trim());

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/ycode/api/apps/discord/settings').then((response) => response.json()),
      fetch('/ycode/api/form-submissions?summary=true').then((response) => response.json()),
    ])
      .then(([settings, summaries]) => {
        if (cancelled) return;
        setConnections((settings.data?.connections as DiscordConnection[] | undefined) ?? []);
        setForms(((summaries.data as FormSummary[] | undefined) ?? []).map((summary) => summary.form_id));
      })
      .catch(() => toast.error('Failed to load Discord settings'))
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveConnections = useCallback(async (next: DiscordConnection[]): Promise<boolean> => {
    const response = next.length > 0
      ? await fetch('/ycode/api/apps/discord/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: next }),
      })
      // No channels left: disconnect the app
      : await fetch('/ycode/api/apps/discord/settings', { method: 'DELETE' });
    if (!response.ok) {
      toast.error('Failed to save Discord settings');
      return false;
    }
    setConnections(next);
    onConnectionChange(next.length > 0);
    return true;
  }, [onConnectionChange]);

  const resetForm = () => {
    setIsAdding(false);
    setName('');
    setWebhookUrl('');
    setFormId(ALL_FORMS);
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const response = await fetch('/ycode/api/apps/discord/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: webhookUrl.trim() }),
      });
      const result = await response.json();
      if (response.ok) toast.success('Test message sent. Check your Discord channel.');
      else toast.error(result.error || 'Failed to send the test message');
    } catch {
      toast.error('Failed to send the test message');
    } finally {
      setIsTesting(false);
    }
  };

  const handleAdd = async () => {
    setIsSaving(true);
    try {
      const connection: DiscordConnection = {
        id: crypto.randomUUID(),
        name: name.trim() || 'Discord channel',
        webhookUrl: webhookUrl.trim(),
        formId,
        enabled: true,
      };
      if (await saveConnections([...connections, connection])) {
        toast.success('Channel added');
        resetForm();
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggle = (id: string, enabled: boolean) => saveConnections(
    connections.map((connection) => (connection.id === id ? { ...connection, enabled } : connection)),
  );

  const handleDelete = async () => {
    if (!connectionToDelete) return;
    if (await saveConnections(connections.filter((connection) => connection.id !== connectionToDelete.id))) {
      toast.success('Channel removed');
    }
    setConnectionToDelete(null);
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle className="mr-auto">Discord</SheetTitle>
        <SheetDescription className="sr-only">Discord integration settings</SheetDescription>
      </SheetHeader>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <div className="mt-3 space-y-6">
          <FieldDescription>
            Get a message in a Discord channel whenever someone submits a form. In Discord, open{' '}
            <span className="text-foreground">Channel settings &rarr; Integrations &rarr; Webhooks</span>,
            create a webhook and copy its URL.
          </FieldDescription>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <FieldLegend>Channels</FieldLegend>
              {!isAdding && (
                <Button
                  variant="secondary" size="xs"
                  onClick={() => setIsAdding(true)}
                >
                  <Icon name="plus" className="size-3 mr-1" />
                  Add
                </Button>
              )}
            </div>

            {connections.length > 0 ? (
              <div className="space-y-2">
                {connections.map((connection) => (
                  <div key={connection.id} className="border rounded-lg flex items-center gap-3 p-3">
                    <div className="flex-1 min-w-0">
                      <Label className="font-medium text-xs">{connection.name}</Label>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {formLabel(connection.formId)}
                      </div>
                    </div>
                    <Switch
                      checked={connection.enabled}
                      onCheckedChange={(enabled) => handleToggle(connection.id, enabled)}
                    />
                    <Button
                      variant="ghost" size="xs"
                      aria-label={`Remove ${connection.name}`}
                      onClick={() => setConnectionToDelete(connection)}
                    >
                      <Icon name="trash" className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : !isAdding && (
              <FieldDescription>No channels yet. Add one to start receiving form submissions.</FieldDescription>
            )}
          </div>

          {isAdding && (
            <div className="space-y-4 border rounded-lg p-4">
              <Field>
                <FieldLabel htmlFor="discord-name">Name</FieldLabel>
                <Input
                  id="discord-name"
                  placeholder="e.g. #website-leads"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="discord-url">Webhook URL</FieldLabel>
                <Input
                  id="discord-url"
                  type="password"
                  placeholder="https://discord.com/api/webhooks/…"
                  value={webhookUrl}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                  className="font-mono text-xs"
                />
                {webhookUrl.trim() && !urlIsValid && (
                  <FieldDescription>This is not a Discord webhook URL.</FieldDescription>
                )}
              </Field>

              <Field>
                <FieldLabel>Form</FieldLabel>
                <Select value={formId} onValueChange={setFormId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FORMS}>All forms</SelectItem>
                    {forms.map((form) => (
                      <SelectItem key={form} value={form}>{form}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Forms appear here after their first submission.</FieldDescription>
              </Field>

              <div className="flex gap-2">
                <Button
                  variant="secondary" size="sm"
                  onClick={handleTest}
                  disabled={!urlIsValid || isTesting}
                >
                  {isTesting ? 'Sending...' : 'Send test message'}
                </Button>
                <Button
                  size="sm" onClick={handleAdd}
                  disabled={!urlIsValid || isSaving}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  variant="ghost" size="sm"
                  onClick={resetForm}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!connectionToDelete}
        onOpenChange={(open) => !open && setConnectionToDelete(null)}
        title="Remove channel?"
        description={`Form submissions will no longer be sent to "${connectionToDelete?.name}".`}
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={handleDelete}
      />
    </>
  );
}
