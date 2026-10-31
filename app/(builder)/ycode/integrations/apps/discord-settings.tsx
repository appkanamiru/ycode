'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldDescription, FieldLabel, FieldLegend } from '@/components/ui/field';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { normalizeConnection } from '@/lib/apps/discord';
import { COMMON_VARIABLES, DISCORD_EVENTS, type EventVariable } from '@/lib/apps/discord/messages';
import type { DiscordConnection } from '@/lib/apps/discord/types';
import type { WebhookEventType } from '@/lib/repositories/webhookRepository';
import type { FormSummary } from '@/types';

interface DiscordSettingsProps {
  onConnectionChange: (connected: boolean) => void;
}

const WEBHOOK_URL_PATTERN = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;
const ANY = '__any__';
const EVENT_LABELS = new Map(DISCORD_EVENTS.map((definition) => [definition.type, definition.label]));

interface Draft {
  id: string | null;
  name: string;
  webhookUrl: string;
  events: WebhookEventType[];
  formId: string;
  collectionId: string;
  /** Own message per event; events without one get the default card */
  templates: Partial<Record<WebhookEventType, string>>;
}

const EMPTY_DRAFT: Draft = {
  id: null, name: '', webhookUrl: '', events: ['form.submitted'], formId: ANY, collectionId: ANY, templates: {},
};

/**
 * Discord app: channels (webhooks) that get a message when chosen site events happen
 */
export default function DiscordSettings({ onConnectionChange }: DiscordSettingsProps) {
  const [connections, setConnections] = useState<DiscordConnection[]>([]);
  const [forms, setForms] = useState<string[]>([]);
  const [collections, setCollections] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [draft, setDraft] = useState<Draft | null>(null);
  /** Event whose message is being edited, and which the test message shows */
  const [activeEvent, setActiveEvent] = useState<WebhookEventType>('form.submitted');
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [connectionToDelete, setConnectionToDelete] = useState<DiscordConnection | null>(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/ycode/api/apps/discord/settings').then((response) => response.json()),
      fetch('/ycode/api/form-submissions?summary=true').then((response) => response.json()),
      fetch('/ycode/api/collections').then((response) => response.json()),
    ])
      .then(([settings, summaries, collectionList]) => {
        if (cancelled) return;
        setConnections(((settings.data?.connections as DiscordConnection[] | undefined) ?? []).map(normalizeConnection));
        setForms(((summaries.data as FormSummary[] | undefined) ?? []).map((summary) => summary.form_id));
        setCollections(((collectionList.data as Array<{ id: string; name: string }> | undefined) ?? [])
          .map(({ id, name }) => ({ id, name })));
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

  const urlIsValid = draft ? WEBHOOK_URL_PATTERN.test(draft.webhookUrl.trim()) : false;
  const hasFormEvent = draft?.events.includes('form.submitted') ?? false;
  const hasCollectionEvent = draft?.events.some((type) => type.startsWith('collection_item.')) ?? false;

  /** Variables of the event being edited, after the common ones */
  const variables = useMemo<EventVariable[]>(() => [
    ...COMMON_VARIABLES,
    ...(DISCORD_EVENTS.find((definition) => definition.type === activeEvent)?.variables ?? []),
  ], [activeEvent]);
  const activeTemplate = draft?.templates[activeEvent] ?? '';
  const setActiveTemplate = (template: string) => update({ templates: { ...draft?.templates, [activeEvent]: template } });

  const update = (changes: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...changes } : current));

  const toggleEvent = (type: WebhookEventType, checked: boolean) => {
    if (!draft) return;
    const events = checked
      ? DISCORD_EVENTS.map((definition) => definition.type).filter((t) => t === type || draft.events.includes(t))
      : draft.events.filter((t) => t !== type);
    update({ events });
    if (checked || activeEvent === type) setActiveEvent(checked ? type : events[0] ?? 'form.submitted');
  };

  const insertVariable = (name: string) => {
    if (!draft) return;
    const placeholder = `{{${name.replace('<field name>', '')}}}`;
    const textarea = templateRef.current;
    const start = textarea?.selectionStart ?? activeTemplate.length;
    const end = textarea?.selectionEnd ?? activeTemplate.length;
    setActiveTemplate(activeTemplate.slice(0, start) + placeholder + activeTemplate.slice(end));
    requestAnimationFrame(() => {
      textarea?.focus();
      // Field variables leave the cursor where the field name goes
      const cursor = start + placeholder.length - (name.includes('<field name>') ? 2 : 0);
      textarea?.setSelectionRange(cursor, cursor);
    });
  };

  const openDraft = (connection?: DiscordConnection) => {
    if (!connection) {
      setDraft({ ...EMPTY_DRAFT });
      setActiveEvent('form.submitted');
      return;
    }
    setDraft({
      id: connection.id,
      name: connection.name,
      webhookUrl: connection.webhookUrl,
      events: connection.events,
      formId: connection.filters?.form_id || ANY,
      collectionId: connection.filters?.collection_id || ANY,
      templates: connection.templates ?? {},
    });
    setActiveEvent(connection.events[0] ?? 'form.submitted');
  };

  const handleTest = async () => {
    if (!draft) return;
    setIsTesting(true);
    try {
      const response = await fetch('/ycode/api/apps/discord/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: draft.webhookUrl.trim(), event: activeEvent, template: activeTemplate }),
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

  const handleSave = async () => {
    if (!draft) return;
    setIsSaving(true);
    try {
      const existing = connections.find((connection) => connection.id === draft.id);
      const connection: DiscordConnection = {
        id: draft.id ?? crypto.randomUUID(),
        name: draft.name.trim() || 'Discord channel',
        webhookUrl: draft.webhookUrl.trim(),
        events: draft.events,
        filters: {
          form_id: hasFormEvent && draft.formId !== ANY ? draft.formId : null,
          collection_id: hasCollectionEvent && draft.collectionId !== ANY ? draft.collectionId : null,
        },
        // Only the chosen events' messages that say something
        templates: Object.fromEntries(Object.entries(draft.templates)
          .filter(([type, template]) => draft.events.includes(type as WebhookEventType) && template?.trim())),
        enabled: existing?.enabled ?? true,
      };
      const next = existing
        ? connections.map((item) => (item.id === connection.id ? connection : item))
        : [...connections, connection];
      if (await saveConnections(next)) {
        toast.success(existing ? 'Channel updated' : 'Channel added');
        setDraft(null);
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

  const describe = (connection: DiscordConnection) => {
    const events = connection.events.map((type) => EVENT_LABELS.get(type) ?? type).join(', ') || 'No events';
    const form = connection.filters?.form_id;
    const collection = collections.find((item) => item.id === connection.filters?.collection_id)?.name;
    return [events, form && `form ${form}`, collection && `collection ${collection}`].filter(Boolean).join(' · ');
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
            Get a message in a Discord channel when something happens on your site. In Discord, open{' '}
            <span className="text-foreground">Channel settings &rarr; Integrations &rarr; Webhooks</span>,
            create a webhook and copy its URL.
          </FieldDescription>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <FieldLegend>Channels</FieldLegend>
              {!draft && (
                <Button
                  variant="secondary" size="xs"
                  onClick={() => openDraft()}
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
                      <div className="text-[11px] text-muted-foreground line-clamp-2">
                        {describe(connection)}
                        {Object.keys(connection.templates ?? {}).length > 0 ? ' · own messages' : ''}
                      </div>
                    </div>
                    <Switch
                      checked={connection.enabled}
                      onCheckedChange={(enabled) => handleToggle(connection.id, enabled)}
                    />
                    <Button
                      variant="ghost" size="xs"
                      aria-label={`Edit ${connection.name}`}
                      onClick={() => openDraft(connection)}
                    >
                      <Icon name="pencil" className="size-3" />
                    </Button>
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
            ) : !draft && (
              <FieldDescription>No channels yet. Add one to start receiving messages.</FieldDescription>
            )}
          </div>

          {draft && (
            <div className="space-y-5 border rounded-lg p-4">
              <Field>
                <FieldLabel htmlFor="discord-name">Name</FieldLabel>
                <Input
                  id="discord-name"
                  placeholder="e.g. #website"
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="discord-url">Webhook URL</FieldLabel>
                <Input
                  id="discord-url"
                  type="password"
                  placeholder="https://discord.com/api/webhooks/…"
                  value={draft.webhookUrl}
                  onChange={(event) => update({ webhookUrl: event.target.value })}
                  className="font-mono text-xs"
                />
                {draft.webhookUrl.trim() && !urlIsValid && (
                  <FieldDescription>This is not a Discord webhook URL.</FieldDescription>
                )}
              </Field>

              <Field>
                <FieldLabel>Events</FieldLabel>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {DISCORD_EVENTS.map((definition) => (
                    <label key={definition.type} className="flex items-center gap-2 text-xs cursor-pointer">
                      <Checkbox
                        checked={draft.events.includes(definition.type)}
                        onCheckedChange={(checked) => toggleEvent(definition.type, checked === true)}
                      />
                      {definition.label}
                    </label>
                  ))}
                </div>
              </Field>

              {hasFormEvent && (
                <Field>
                  <FieldLabel>Form</FieldLabel>
                  <Select value={draft.formId} onValueChange={(formId) => update({ formId })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>All forms</SelectItem>
                      {forms.map((form) => (
                        <SelectItem key={form} value={form}>{form}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>Forms appear here after their first submission.</FieldDescription>
                </Field>
              )}

              {hasCollectionEvent && (
                <Field>
                  <FieldLabel>Collection</FieldLabel>
                  <Select value={draft.collectionId} onValueChange={(collectionId) => update({ collectionId })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>All collections</SelectItem>
                      {collections.map((collection) => (
                        <SelectItem key={collection.id} value={collection.id}>{collection.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}

              {draft.events.length > 0 && (
                <Field>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor="discord-template">Message for</FieldLabel>
                    <Select value={activeEvent} onValueChange={(type) => setActiveEvent(type as WebhookEventType)}>
                      <SelectTrigger className="w-auto">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {draft.events.map((type) => (
                          <SelectItem key={type} value={type}>
                            {EVENT_LABELS.get(type) ?? type}{draft.templates[type]?.trim() ? ' ✎' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Textarea
                    id="discord-template"
                    ref={templateRef}
                    rows={4}
                    placeholder="Leave empty for a card with the event's details, or write your own message"
                    value={activeTemplate}
                    onChange={(event) => setActiveTemplate(event.target.value)}
                    className="font-mono text-xs"
                  />
                  <FieldDescription>
                    Each event has its own message. Click a variable to insert it.
                  </FieldDescription>
                  <div className="flex flex-wrap gap-1.5">
                    {variables.map((variable) => (
                      <button
                        key={variable.name}
                        type="button"
                        title={variable.description}
                        onClick={() => insertVariable(variable.name)}
                        className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground hover:bg-secondary/70"
                      >
                        {`{{${variable.name}}}`}
                      </button>
                    ))}
                  </div>
                  <div>
                    <Button
                      variant="secondary" size="sm"
                      onClick={handleTest}
                      disabled={!urlIsValid || isTesting}
                    >
                      {isTesting ? 'Sending...' : `Send test: ${EVENT_LABELS.get(activeEvent) ?? activeEvent}`}
                    </Button>
                  </div>
                </Field>
              )}

              <div className="flex gap-2 border-t pt-4">
                <Button
                  size="sm" onClick={handleSave}
                  disabled={!urlIsValid || draft.events.length === 0 || isSaving}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setDraft(null)}
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
        description={`Messages will no longer be sent to "${connectionToDelete?.name}".`}
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={handleDelete}
      />
    </>
  );
}
