import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronsUpDown,
  Copy,
  Clock3,
  KeyRound,
  Link2,
  Loader2,
  LockKeyhole,
  Network,
  Plus,
  RefreshCcw,
  Shield,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsSectionCard } from '@/components/settings-center/settings-section-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import {
  useRemoteInstancesStore,
  type RemoteAgentCardCapability,
  type RemoteInstance,
  type RemoteInstanceAuthMode,
  type RemoteInstanceSelf,
} from '@/stores/remote-instances';

type DraftState = {
  displayName: string;
  agentCardUrl: string;
  authMode: RemoteInstanceAuthMode;
  bearerToken: string;
  headersText: string;
};

type SelfDraftState = {
  enabled: boolean;
  agentCardName: string;
  agentCardDescription: string;
  allowUnauthenticated: boolean;
  networkMode: 'local' | 'lan';
};

const EMPTY_DRAFT: DraftState = {
  displayName: '',
  agentCardUrl: '',
  authMode: 'none',
  bearerToken: '',
  headersText: '',
};

const EMPTY_SELF_DRAFT: SelfDraftState = {
  enabled: false,
  agentCardName: '',
  agentCardDescription: '',
  allowUnauthenticated: false,
  networkMode: 'local',
};

function formatTimestamp(value: string | null, locale: string): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function stringifyHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function parseHeadersText(raw: string): Record<string, string> {
  const nextHeaders: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid header line: ${trimmedLine}`);
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (!key || !value) {
      throw new Error(`Invalid header line: ${trimmedLine}`);
    }

    nextHeaders[key] = value;
  }

  return nextHeaders;
}

function deriveDraft(instance: RemoteInstance | null): DraftState {
  if (!instance) {
    return EMPTY_DRAFT;
  }

  return {
    displayName: instance.displayName ?? '',
    agentCardUrl: instance.agentCardUrl,
    authMode: instance.authMode,
    bearerToken: instance.bearerToken ?? '',
    headersText: stringifyHeaders(instance.headers),
  };
}

function deriveSelfDraft(self: RemoteInstanceSelf | null): SelfDraftState {
  if (!self) {
    return EMPTY_SELF_DRAFT;
  }

  return {
    enabled: self.enabled,
    agentCardName: self.inbound.agentCard.name ?? '',
    agentCardDescription: self.inbound.agentCard.description ?? '',
    allowUnauthenticated: self.inbound.allowUnauthenticated,
    networkMode: self.network.mode,
  };
}

function statusBadgeVariant(instance: RemoteInstance): 'success' | 'warning' | 'secondary' {
  if (instance.lastTest?.ok) {
    return 'success';
  }

  if (instance.lastTest) {
    return 'warning';
  }

  return 'secondary';
}

function statusLabel(instance: RemoteInstance, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (instance.lastTest?.ok) {
    return t('remoteInstances.list.statusConnected');
  }

  if (instance.lastTest) {
    return t('remoteInstances.list.statusNeedsAttention');
  }

  return t('remoteInstances.list.statusNotChecked');
}

function capabilityLabel(capability: RemoteAgentCardCapability): string {
  return capability.label || capability.id;
}

async function copyToClipboard(value: string, successMessage: string, fallbackMessage: string) {
  if (!value) {
    return;
  }

  try {
    await navigator.clipboard?.writeText(value);
    toast.success(successMessage);
  } catch {
    toast.error(fallbackMessage);
  }
}

function CopyButton({
  value,
  label,
  successMessage,
  fallbackMessage,
}: {
  value: string | null;
  label: string;
  successMessage: string;
  fallbackMessage: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={label}
            disabled={!value}
            onClick={() => value && void copyToClipboard(value, successMessage, fallbackMessage)}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function UrlRow({
  label,
  value,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
}: {
  label: string;
  value: string | null;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-white px-3 py-2 dark:bg-background">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 truncate font-mono text-[12px] text-[#0f172a] dark:text-foreground">
          {value || '—'}
        </p>
      </div>
      <CopyButton
        value={value}
        label={copyLabel}
        successMessage={copiedLabel}
        fallbackMessage={copyFailedLabel}
      />
    </div>
  );
}

function ConnectionStatus({
  instance,
  locale,
  t,
}: {
  instance: RemoteInstance;
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (!instance.lastTest) {
    return (
      <div className="rounded-xl border border-dashed border-black/10 bg-[#f8fafc] px-4 py-3 text-[12px] text-[#64748b] dark:border-white/10 dark:bg-muted/40 dark:text-muted-foreground">
        {t('remoteInstances.details.connectionEmpty')}
      </div>
    );
  }

  const ok = instance.lastTest.ok;
  const icon = ok ? CheckCircle2 : AlertCircle;
  const Icon = icon;
  const checkedAt = formatTimestamp(instance.lastTest.checkedAt, locale);

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100'
          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'
      }`}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">
            {instance.lastTest.status}
          </p>
          {instance.lastTest.message ? (
            <p className="mt-1 text-[12px] opacity-90">{instance.lastTest.message}</p>
          ) : null}
          {checkedAt ? (
            <p className="mt-2 text-[11px] opacity-75">
              {t('remoteInstances.details.lastChecked', { checkedAt })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SettingsRemoteInstancesPanel() {
  const { t, i18n } = useTranslation('settings');
  const instances = useRemoteInstancesStore((state) => state.instances);
  const selectedInstanceId = useRemoteInstancesStore((state) => state.selectedInstanceId);
  const self = useRemoteInstancesStore((state) => state.self);
  const selfLoading = useRemoteInstancesStore((state) => state.selfLoading);
  const selfSaving = useRemoteInstancesStore((state) => state.selfSaving);
  const selfGeneratingKey = useRemoteInstancesStore((state) => state.selfGeneratingKey);
  const selfRevokingKeyByLabel = useRemoteInstancesStore((state) => state.selfRevokingKeyByLabel);
  const loading = useRemoteInstancesStore((state) => state.loading);
  const loaded = useRemoteInstancesStore((state) => state.loaded);
  const creating = useRemoteInstancesStore((state) => state.creating);
  const error = useRemoteInstancesStore((state) => state.error);
  const busyById = useRemoteInstancesStore((state) => state.busyById);
  const clearError = useRemoteInstancesStore((state) => state.clearError);
  const fetchSelf = useRemoteInstancesStore((state) => state.fetchSelf);
  const updateSelf = useRemoteInstancesStore((state) => state.updateSelf);
  const generateSelfAccessKey = useRemoteInstancesStore((state) => state.generateSelfAccessKey);
  const revokeSelfAccessKey = useRemoteInstancesStore((state) => state.revokeSelfAccessKey);
  const clearSelfNewAccessKey = useRemoteInstancesStore((state) => state.clearSelfNewAccessKey);
  const fetchInstances = useRemoteInstancesStore((state) => state.fetchInstances);
  const createInstance = useRemoteInstancesStore((state) => state.createInstance);
  const selectInstance = useRemoteInstancesStore((state) => state.selectInstance);
  const updateInstance = useRemoteInstancesStore((state) => state.updateInstance);
  const deleteInstance = useRemoteInstancesStore((state) => state.deleteInstance);
  const refreshAgentCard = useRemoteInstancesStore((state) => state.refreshAgentCard);
  const testConnection = useRemoteInstancesStore((state) => state.testConnection);

  const [addForm, setAddForm] = useState({ agentCardUrl: '', displayName: '' });
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [selfDraft, setSelfDraft] = useState<SelfDraftState>(EMPTY_SELF_DRAFT);
  const [newAccessKeyLabel, setNewAccessKeyLabel] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RemoteInstance | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);

  useEffect(() => {
    void fetchInstances();
    void fetchSelf();
  }, [fetchInstances, fetchSelf]);

  const selectedInstance = useMemo(
    () => instances.find((instance) => instance.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId],
  );

  useEffect(() => {
    setDraft(deriveDraft(selectedInstance));
  }, [selectedInstance]);

  useEffect(() => {
    setSelfDraft(deriveSelfDraft(self));
  }, [self]);

  const addDisabled = creating || !addForm.agentCardUrl.trim();
  const generateKeyDisabled = selfGeneratingKey || !newAccessKeyLabel.trim();

  const handleAddInstance = async () => {
    clearError();
    try {
      const instance = await createInstance({
        agentCardUrl: addForm.agentCardUrl.trim(),
        displayName: addForm.displayName.trim() || undefined,
      });

      setAddForm({ agentCardUrl: '', displayName: '' });
      setDraft(deriveDraft(instance));
      toast.success(t('remoteInstances.toasts.created'));
    } catch (createError) {
      toast.error(createError instanceof Error ? createError.message : t('remoteInstances.toasts.createFailed'));
    }
  };

  const handleSaveSelf = async () => {
    clearError();
    try {
      await updateSelf({
        enabled: selfDraft.enabled,
        agentCardName: selfDraft.agentCardName.trim(),
        agentCardDescription: selfDraft.agentCardDescription.trim(),
        allowUnauthenticated: selfDraft.allowUnauthenticated,
        networkMode: selfDraft.networkMode,
      });
      toast.success(t('remoteInstances.self.toasts.saved'));
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : t('remoteInstances.self.toasts.saveFailed'));
    }
  };

  const handleGenerateSelfAccessKey = async () => {
    const label = newAccessKeyLabel.trim();
    if (!label) {
      return;
    }

    clearError();
    try {
      await generateSelfAccessKey(label);
      setNewAccessKeyLabel('');
      toast.success(t('remoteInstances.self.toasts.keyGenerated'));
    } catch (generateError) {
      toast.error(generateError instanceof Error ? generateError.message : t('remoteInstances.self.toasts.keyGenerateFailed'));
    }
  };

  const handleRevokeSelfAccessKey = async (label: string) => {
    clearError();
    try {
      await revokeSelfAccessKey(label);
      toast.success(t('remoteInstances.self.toasts.keyRevoked'));
    } catch (revokeError) {
      toast.error(revokeError instanceof Error ? revokeError.message : t('remoteInstances.self.toasts.keyRevokeFailed'));
    }
  };

  const handleSaveDetails = async () => {
    if (!selectedInstance) {
      return;
    }

    setSavingDetails(true);
    clearError();

    try {
      const usesHeaders = draft.authMode === 'headers' || draft.authMode === 'mixed';
      const headers = usesHeaders ? parseHeadersText(draft.headersText) : {};
      await updateInstance(selectedInstance.id, {
        displayName: draft.displayName.trim() || undefined,
        agentCardUrl: draft.agentCardUrl.trim() || undefined,
        authMode: draft.authMode,
        bearerToken:
          draft.authMode === 'bearer' || draft.authMode === 'mixed'
            ? draft.bearerToken.trim() || null
            : null,
        headers:
          usesHeaders ? headers : {},
      });
      toast.success(t('remoteInstances.toasts.saved'));
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : t('remoteInstances.toasts.saveFailed'));
    } finally {
      setSavingDetails(false);
    }
  };

  const handleRefreshAgentCard = async (instance: RemoteInstance) => {
    clearError();
    try {
      await refreshAgentCard(instance.id);
      toast.success(t('remoteInstances.toasts.refreshed'));
    } catch (refreshError) {
      toast.error(
        refreshError instanceof Error ? refreshError.message : t('remoteInstances.toasts.refreshFailed'),
      );
    }
  };

  const handleTestConnection = async (instance: RemoteInstance) => {
    clearError();
    try {
      const result = await testConnection(instance.id);
      toast.success(
        result.ok ? t('remoteInstances.toasts.testPassed') : t('remoteInstances.toasts.testCompleted'),
      );
    } catch (testError) {
      toast.error(testError instanceof Error ? testError.message : t('remoteInstances.toasts.testFailed'));
    }
  };

  const handleDeleteInstance = async () => {
    if (!deleteTarget) {
      return;
    }

    try {
      await deleteInstance(deleteTarget.id);
      toast.success(t('remoteInstances.toasts.deleted'));
      setDeleteTarget(null);
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : t('remoteInstances.toasts.deleteFailed'));
      throw deleteError;
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSectionCard title={t('remoteInstances.intro.title')}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="rounded-xl border border-black/5 bg-[#f8fafc] p-4 dark:border-white/10 dark:bg-muted/40">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-white p-2 text-[#2563eb] shadow-sm dark:bg-background">
                <Link2 className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intro.urlFirstTitle')}
                </p>
                <p className="mt-1 text-[12px] leading-6 text-[#64748b] dark:text-muted-foreground">
                  {t('remoteInstances.intro.urlFirstDescription')}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-black/5 bg-[#f8fafc] p-4 dark:border-white/10 dark:bg-muted/40">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-white p-2 text-[#16a34a] shadow-sm dark:bg-background">
                <Shield className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intro.authLaterTitle')}
                </p>
                <p className="mt-1 text-[12px] leading-6 text-[#64748b] dark:text-muted-foreground">
                  {t('remoteInstances.intro.authLaterDescription')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard title={t('remoteInstances.add.title')}>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px_auto]">
          <label className="space-y-2">
            <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
              {t('remoteInstances.add.agentCardUrlLabel')}
            </span>
            <Input
              aria-label={t('remoteInstances.add.agentCardUrlLabel')}
              placeholder={t('remoteInstances.add.agentCardUrlPlaceholder')}
              value={addForm.agentCardUrl}
              onChange={(event) =>
                setAddForm((current) => ({ ...current, agentCardUrl: event.target.value }))
              }
            />
          </label>

          <label className="space-y-2">
            <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
              {t('remoteInstances.add.displayNameLabel')}
            </span>
            <Input
              aria-label={t('remoteInstances.add.displayNameLabel')}
              placeholder={t('remoteInstances.add.displayNamePlaceholder')}
              value={addForm.displayName}
              onChange={(event) =>
                setAddForm((current) => ({ ...current, displayName: event.target.value }))
              }
            />
          </label>

          <div className="flex items-end">
            <Button
              type="button"
              onClick={() => void handleAddInstance()}
              disabled={addDisabled}
              className="w-full gap-2"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('remoteInstances.add.submit')}
            </Button>
          </div>
        </div>

        <p className="text-[12px] text-[#64748b] dark:text-muted-foreground">
          {t('remoteInstances.add.helper')}
        </p>
      </SettingsSectionCard>

      <SettingsSectionCard title={t('remoteInstances.self.title')}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <div className="rounded-lg bg-white p-2 text-[#0f766e] shadow-sm dark:bg-background">
                <LockKeyhole className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.self.descriptionTitle')}
                </p>
                <p className="mt-1 text-[12px] leading-6 text-[#64748b] dark:text-muted-foreground">
                  {t('remoteInstances.self.description')}
                </p>
              </div>
            </div>
            <label className="flex shrink-0 items-center gap-3 rounded-lg bg-white px-3 py-2 dark:bg-background">
              <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.self.enabledLabel')}
              </span>
              <Switch
                aria-label={t('remoteInstances.self.enabledLabel')}
                checked={selfDraft.enabled}
                disabled={selfLoading || selfSaving}
                onCheckedChange={(checked) =>
                  setSelfDraft((current) => ({ ...current, enabled: checked }))
                }
              />
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-1">
                <label className="space-y-2">
                  <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.self.agentCardNameLabel')}
                  </span>
                  <Input
                    aria-label={t('remoteInstances.self.agentCardNameLabel')}
                    placeholder={t('remoteInstances.self.agentCardNamePlaceholder')}
                    value={selfDraft.agentCardName}
                    onChange={(event) =>
                      setSelfDraft((current) => ({ ...current, agentCardName: event.target.value }))
                    }
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.self.agentCardDescriptionLabel')}
                  </span>
                  <Input
                    aria-label={t('remoteInstances.self.agentCardDescriptionLabel')}
                    placeholder={t('remoteInstances.self.agentCardDescriptionPlaceholder')}
                    value={selfDraft.agentCardDescription}
                    onChange={(event) =>
                      setSelfDraft((current) => ({ ...current, agentCardDescription: event.target.value }))
                    }
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-3 dark:border-white/10 dark:bg-muted/40">
                <div>
                  <p className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.self.allowUnauthenticatedLabel')}
                  </p>
                  <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.self.allowUnauthenticatedHint')}
                  </p>
                </div>
                <Switch
                  aria-label={t('remoteInstances.self.allowUnauthenticatedLabel')}
                  checked={selfDraft.allowUnauthenticated}
                  disabled={selfLoading || selfSaving}
                  onCheckedChange={(checked) =>
                    setSelfDraft((current) => ({ ...current, allowUnauthenticated: checked }))
                  }
                />
              </div>

              <label className="space-y-2">
                <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.self.networkModeLabel')}
                </span>
                <Select
                  aria-label={t('remoteInstances.self.networkModeLabel')}
                  value={selfDraft.networkMode}
                  disabled={selfLoading || selfSaving}
                  onChange={(event) =>
                    setSelfDraft((current) => ({
                      ...current,
                      networkMode: event.target.value === 'lan' ? 'lan' : 'local',
                    }))
                  }
                >
                  <option value="local">{t('remoteInstances.self.networkModes.local')}</option>
                  <option value="lan">{t('remoteInstances.self.networkModes.lan')}</option>
                </Select>
                <p className="text-[12px] leading-6 text-[#64748b] dark:text-muted-foreground">
                  {selfDraft.networkMode === 'lan'
                    ? t('remoteInstances.self.networkLanHint')
                    : t('remoteInstances.self.networkLocalHint')}
                </p>
              </label>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => void handleSaveSelf()}
                  disabled={selfSaving || selfLoading}
                  className="gap-2"
                >
                  {selfSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t('remoteInstances.self.save')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void fetchSelf({ force: true })}
                  disabled={selfLoading}
                  className="gap-2"
                >
                  {selfLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  {t('remoteInstances.self.refresh')}
                </Button>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                      {t('remoteInstances.self.myAgentCardUrlTitle')}
                    </p>
                    <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
                      {t('remoteInstances.self.myAgentCardUrlDescription')}
                    </p>
                  </div>
                  <Badge variant={self?.enabled ? 'success' : 'secondary'}>
                    {self?.enabled ? t('remoteInstances.self.statusEnabled') : t('remoteInstances.self.statusDisabled')}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant={self?.network.mode === 'lan' ? 'warning' : 'secondary'}>
                    {self?.network.mode === 'lan'
                      ? t('remoteInstances.self.networkStatusLan')
                      : t('remoteInstances.self.networkStatusLocal')}
                  </Badge>
                  {self?.network.requiresFirewall ? (
                    <Badge variant="outline">{t('remoteInstances.self.firewallBadge')}</Badge>
                  ) : null}
                </div>

                <div className="mt-4 space-y-2">
                  <UrlRow
                    label={t('remoteInstances.self.localAgentCardUrlLabel')}
                    value={self?.urls.localAgentCardUrl ?? null}
                    copyLabel={t('remoteInstances.self.copyAgentCardUrl')}
                    copiedLabel={t('remoteInstances.self.toasts.copied')}
                    copyFailedLabel={t('remoteInstances.self.toasts.copyFailed')}
                  />
                  <UrlRow
                    label={t('remoteInstances.self.lanAgentCardUrlLabel')}
                    value={self?.urls.lanAgentCardUrl ?? null}
                    copyLabel={t('remoteInstances.self.copyLanAgentCardUrl')}
                    copiedLabel={t('remoteInstances.self.toasts.copied')}
                    copyFailedLabel={t('remoteInstances.self.toasts.copyFailed')}
                  />
                  <UrlRow
                    label={t('remoteInstances.self.localA2AUrlLabel')}
                    value={self?.urls.localA2AEndpointUrl ?? null}
                    copyLabel={t('remoteInstances.self.copyA2AUrl')}
                    copiedLabel={t('remoteInstances.self.toasts.copied')}
                    copyFailedLabel={t('remoteInstances.self.toasts.copyFailed')}
                  />
                </div>

                <div className="mt-4 rounded-lg border border-dashed border-black/10 bg-white px-3 py-3 text-[12px] leading-6 text-[#64748b] dark:border-white/10 dark:bg-background dark:text-muted-foreground">
                  <p>{self?.hints.lan || t('remoteInstances.self.lanHintFallback')}</p>
                  <p className="mt-1">{self?.hints.tailscale || t('remoteInstances.self.tailscaleHint')}</p>
                </div>
              </div>

              <div className="rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                      {t('remoteInstances.self.accessKeysTitle')}
                    </p>
                    <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
                      {t('remoteInstances.self.accessKeysDescription')}
                    </p>
                  </div>
                  <KeyRound className="h-4 w-4 text-[#64748b] dark:text-muted-foreground" />
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                  <Input
                    aria-label={t('remoteInstances.self.newKeyLabel')}
                    placeholder={t('remoteInstances.self.newKeyPlaceholder')}
                    value={newAccessKeyLabel}
                    onChange={(event) => setNewAccessKeyLabel(event.target.value)}
                  />
                  <Button
                    type="button"
                    onClick={() => void handleGenerateSelfAccessKey()}
                    disabled={generateKeyDisabled}
                    className="gap-2"
                  >
                    {selfGeneratingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {t('remoteInstances.self.generateKey')}
                  </Button>
                </div>

                {self?.newAccessKey ? (
                  <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium">
                          {t('remoteInstances.self.newKeyReadyTitle')}
                        </p>
                        <p className="mt-1 text-[12px] opacity-90">
                          {t('remoteInstances.self.newKeyReadyDescription')}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={clearSelfNewAccessKey}
                      >
                        {t('remoteInstances.self.dismissKey')}
                      </Button>
                    </div>
                    <div className="mt-3 flex min-w-0 items-center gap-2 rounded-md bg-white px-3 py-2 dark:bg-background">
                      <code className="min-w-0 flex-1 truncate text-[12px]">
                        {self.newAccessKey.header}
                      </code>
                      <CopyButton
                        value={self.newAccessKey.header}
                        label={t('remoteInstances.self.copyHeader')}
                        successMessage={t('remoteInstances.self.toasts.copied')}
                        fallbackMessage={t('remoteInstances.self.toasts.copyFailed')}
                      />
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 space-y-2">
                  {self?.inbound.apiKeys.length ? (
                    self.inbound.apiKeys.map((apiKey) => {
                      const revoking = Boolean(selfRevokingKeyByLabel[apiKey.label]);
                      return (
                        <div
                          key={apiKey.label}
                          className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 dark:bg-background"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                              {apiKey.label}
                            </p>
                            <p className="mt-1 truncate font-mono text-[11px] text-[#64748b] dark:text-muted-foreground">
                              {apiKey.maskedKey}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            disabled={revoking}
                            onClick={() => void handleRevokeSelfAccessKey(apiKey.label)}
                          >
                            {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            {t('remoteInstances.self.revokeKey')}
                          </Button>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-lg border border-dashed border-black/10 px-3 py-4 text-center text-[12px] text-[#64748b] dark:border-white/10 dark:text-muted-foreground">
                      {t('remoteInstances.self.noKeys')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </SettingsSectionCard>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-100"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.92fr)_minmax(0,1.08fr)]">
        <SettingsSectionCard title={t('remoteInstances.list.title')}>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-3 dark:border-white/10 dark:bg-muted/40">
            <div>
              <p className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                {t('remoteInstances.list.summaryTitle', { count: instances.length })}
              </p>
              <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
                {t('remoteInstances.list.summaryDescription')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void fetchInstances({ force: true })}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              {t('remoteInstances.list.refresh')}
            </Button>
          </div>

          {loading && !loaded ? (
            <div className="rounded-xl border border-dashed border-black/10 px-4 py-8 text-center text-[13px] text-[#64748b] dark:border-white/10 dark:text-muted-foreground">
              {t('remoteInstances.list.loading')}
            </div>
          ) : instances.length === 0 ? (
            <div className="rounded-xl border border-dashed border-black/10 px-4 py-8 text-center text-[13px] text-[#64748b] dark:border-white/10 dark:text-muted-foreground">
              {t('remoteInstances.list.empty')}
            </div>
          ) : (
            <div className="space-y-3">
              {instances.map((instance) => {
                const selected = instance.id === selectedInstanceId;
                const busyState = busyById[instance.id] ?? {};
                const testing = Boolean(busyState.testing);
                const refreshing = Boolean(busyState.refreshing);

                return (
                  <div
                    key={instance.id}
                    className={`rounded-xl border px-4 py-4 transition ${
                      selected
                        ? 'border-[#2563eb] bg-[#eff6ff] shadow-sm dark:border-[#3b82f6] dark:bg-[#172554]/30'
                        : 'border-black/5 bg-[#f8fafc] hover:border-black/10 hover:bg-white dark:border-white/10 dark:bg-muted/40 dark:hover:bg-card'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => selectInstance(instance.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[14px] font-semibold text-[#0f172a] dark:text-foreground">
                            {instance.displayName || instance.agentCard?.name || t('remoteInstances.list.unnamed')}
                          </p>
                          <Badge variant={statusBadgeVariant(instance)}>
                            {statusLabel(instance, t)}
                          </Badge>
                        </div>
                        <p className="mt-2 truncate text-[12px] text-[#64748b] dark:text-muted-foreground">
                          {instance.agentCardUrl}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-[#64748b] dark:text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <KeyRound className="h-3.5 w-3.5" />
                            {t(`remoteInstances.authModes.${instance.authMode}`)}
                          </span>
                          {instance.agentCard?.capabilities.length ? (
                            <span className="inline-flex items-center gap-1">
                              <ChevronsUpDown className="h-3.5 w-3.5" />
                              {t('remoteInstances.list.capabilityCount', {
                                count: instance.agentCard.capabilities.length,
                              })}
                            </span>
                          ) : null}
                        </div>
                      </button>

                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => void handleTestConnection(instance)}
                          disabled={testing}
                        >
                          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Network className="h-3.5 w-3.5" />}
                          {t('remoteInstances.list.test')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={t('remoteInstances.list.refreshCard')}
                          onClick={() => void handleRefreshAgentCard(instance)}
                          disabled={refreshing}
                        >
                          {refreshing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCcw className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SettingsSectionCard>

        <SettingsSectionCard title={t('remoteInstances.details.title')}>
          {!selectedInstance ? (
            <div className="rounded-xl border border-dashed border-black/10 px-4 py-10 text-center text-[13px] text-[#64748b] dark:border-white/10 dark:text-muted-foreground">
              {t('remoteInstances.details.empty')}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3 rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[16px] font-semibold text-[#0f172a] dark:text-foreground">
                      {selectedInstance.displayName ||
                        selectedInstance.agentCard?.name ||
                        t('remoteInstances.list.unnamed')}
                    </p>
                    <Badge variant={statusBadgeVariant(selectedInstance)}>
                      {statusLabel(selectedInstance, t)}
                    </Badge>
                  </div>
                  <p className="mt-2 text-[12px] text-[#64748b] dark:text-muted-foreground">
                    {selectedInstance.agentCard?.description || t('remoteInstances.details.noDescription')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="gap-2"
                  onClick={() => setDeleteTarget(selectedInstance)}
                  disabled={Boolean(busyById[selectedInstance.id]?.deleting)}
                >
                  <Trash2 className="h-4 w-4" />
                  {t('remoteInstances.details.delete')}
                </Button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.details.displayNameLabel')}
                  </span>
                  <Input
                    aria-label={t('remoteInstances.details.displayNameLabel')}
                    value={draft.displayName}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, displayName: event.target.value }))
                    }
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.details.agentCardUrlLabel')}
                  </span>
                  <Input
                    aria-label={t('remoteInstances.details.agentCardUrlLabel')}
                    value={draft.agentCardUrl}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, agentCardUrl: event.target.value }))
                    }
                  />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                <label className="space-y-2">
                  <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.details.authModeLabel')}
                  </span>
                  <Select
                    aria-label={t('remoteInstances.details.authModeLabel')}
                    value={draft.authMode}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        authMode: event.target.value as RemoteInstanceAuthMode,
                      }))
                    }
                  >
                    <option value="none">{t('remoteInstances.authModes.none')}</option>
                    <option value="bearer">{t('remoteInstances.authModes.bearer')}</option>
                    <option value="headers">{t('remoteInstances.authModes.headers')}</option>
                    <option value="mixed">{t('remoteInstances.authModes.mixed')}</option>
                  </Select>
                </label>

                {(draft.authMode === 'bearer' || draft.authMode === 'mixed') ? (
                  <label className="space-y-2">
                    <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                      {t('remoteInstances.details.bearerTokenLabel')}
                    </span>
                    <Input
                      aria-label={t('remoteInstances.details.bearerTokenLabel')}
                      type="password"
                      placeholder={t('remoteInstances.details.bearerTokenPlaceholder')}
                      value={draft.bearerToken}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, bearerToken: event.target.value }))
                      }
                    />
                  </label>
                ) : (
                  <div className="rounded-xl border border-dashed border-black/10 px-4 py-3 text-[12px] text-[#64748b] dark:border-white/10 dark:text-muted-foreground">
                    {t('remoteInstances.details.authHint')}
                  </div>
                )}
              </div>

              {(draft.authMode === 'headers' || draft.authMode === 'mixed') ? (
                <label className="space-y-2">
                  <span className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.details.headersLabel')}
                  </span>
                  <Textarea
                    aria-label={t('remoteInstances.details.headersLabel')}
                    placeholder={t('remoteInstances.details.headersPlaceholder')}
                    value={draft.headersText}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, headersText: event.target.value }))
                    }
                    className="min-h-[120px]"
                  />
                </label>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => void handleSaveDetails()}
                  disabled={savingDetails || Boolean(busyById[selectedInstance.id]?.saving)}
                  className="gap-2"
                >
                  {(savingDetails || busyById[selectedInstance.id]?.saving) ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {t('remoteInstances.details.save')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleTestConnection(selectedInstance)}
                  disabled={Boolean(busyById[selectedInstance.id]?.testing)}
                  className="gap-2"
                >
                  {busyById[selectedInstance.id]?.testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Network className="h-4 w-4" />
                  )}
                  {t('remoteInstances.details.test')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleRefreshAgentCard(selectedInstance)}
                  disabled={Boolean(busyById[selectedInstance.id]?.refreshing)}
                  className="gap-2"
                >
                  {busyById[selectedInstance.id]?.refreshing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="h-4 w-4" />
                  )}
                  {t('remoteInstances.details.refreshCard')}
                </Button>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                <div className="space-y-4">
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <Clock3 className="h-4 w-4 text-[#64748b] dark:text-muted-foreground" />
                      <p className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                        {t('remoteInstances.details.connectionTitle')}
                      </p>
                    </div>
                    <ConnectionStatus instance={selectedInstance} locale={i18n.language} t={t} />
                  </div>

                  <div className="rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
                    <p className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                      {t('remoteInstances.details.metadataTitle')}
                    </p>
                    <div className="mt-3 space-y-2 text-[12px] text-[#64748b] dark:text-muted-foreground">
                      <div className="flex items-center justify-between gap-3">
                        <span>{t('remoteInstances.details.metadataCreated')}</span>
                        <span>{formatTimestamp(selectedInstance.createdAt, i18n.language) || '—'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>{t('remoteInstances.details.metadataUpdated')}</span>
                        <span>{formatTimestamp(selectedInstance.updatedAt, i18n.language) || '—'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-xl border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[13px] font-medium text-[#0f172a] dark:text-foreground">
                          {t('remoteInstances.details.agentCardTitle')}
                        </p>
                        <p className="mt-1 text-[12px] text-[#64748b] dark:text-muted-foreground">
                          {selectedInstance.agentCard?.url || selectedInstance.agentCardUrl}
                        </p>
                      </div>
                      {selectedInstance.agentCard?.version ? (
                        <Badge variant="outline">{selectedInstance.agentCard.version}</Badge>
                      ) : null}
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {selectedInstance.agentCard?.capabilities.length ? (
                        selectedInstance.agentCard.capabilities.map((capability) => (
                          <Badge key={capability.id} variant="secondary" className="max-w-full">
                            <span className="truncate">{capabilityLabel(capability)}</span>
                          </Badge>
                        ))
                      ) : (
                        <span className="text-[12px] text-[#64748b] dark:text-muted-foreground">
                          {t('remoteInstances.details.capabilitiesEmpty')}
                        </span>
                      )}
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                        <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                          {t('remoteInstances.details.inputModes')}
                        </p>
                        <p className="mt-2 text-[12px] text-[#0f172a] dark:text-foreground">
                          {selectedInstance.agentCard?.defaultInputModes.join(', ') ||
                            t('remoteInstances.details.modesEmpty')}
                        </p>
                      </div>
                      <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                        <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                          {t('remoteInstances.details.outputModes')}
                        </p>
                        <p className="mt-2 text-[12px] text-[#0f172a] dark:text-foreground">
                          {selectedInstance.agentCard?.defaultOutputModes.join(', ') ||
                            t('remoteInstances.details.modesEmpty')}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-lg bg-white px-3 py-3 dark:bg-background">
                      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                        {t('remoteInstances.details.skills')}
                      </p>
                      <p className="mt-2 text-[12px] text-[#0f172a] dark:text-foreground">
                        {selectedInstance.agentCard?.skills.join(', ') || t('remoteInstances.details.skillsEmpty')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </SettingsSectionCard>
      </div>

      <ConfirmDialog
        open={deleteTarget != null}
        title={t('remoteInstances.deleteDialog.title')}
        message={
          deleteTarget
            ? t('remoteInstances.deleteDialog.message', {
                name:
                  deleteTarget.displayName ||
                  deleteTarget.agentCard?.name ||
                  deleteTarget.agentCardUrl,
              })
            : ''
        }
        confirmLabel={t('remoteInstances.deleteDialog.confirm')}
        cancelLabel={t('remoteInstances.deleteDialog.cancel')}
        variant="destructive"
        onConfirm={handleDeleteInstance}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
