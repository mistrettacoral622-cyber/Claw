import { useEffect, useMemo } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  MonitorCog,
  RefreshCcw,
  Router,
  Shield,
  Terminal,
  Waypoints,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SettingsSectionCard } from '@/components/settings-center/settings-section-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useIntercomStore, type IntercomRoute } from '@/stores/intercom';
import { toast } from '@/lib/toast';
import { INTERCOM_CONNECTION_SHARE_TYPE } from '@/components/remote-instances/intercom-ui-utils';

function routeAddress(route: IntercomRoute): string {
  return route.sshUser ? `${route.sshUser}@${route.host}` : route.host;
}

function routePort(route: IntercomRoute): string {
  return route.sshPort ? String(route.sshPort) : '22';
}

function selfRouteAddress(config: {
  host: string;
  sshUser: string | null;
}): string {
  return config.sshUser ? `${config.sshUser}@${config.host}` : config.host;
}

function buildConnectionShareText(config: {
  host: string;
  sshUser: string | null;
  sshPort: number;
  agentId: string;
  sessionId: string;
  remoteCommand: string;
  routeIdExample: string;
  displayNameExample: string;
}): string {
  return JSON.stringify({
    type: INTERCOM_CONNECTION_SHARE_TYPE,
    version: 1,
    routeId: config.routeIdExample,
    displayName: config.displayNameExample,
    host: config.host,
    sshUser: config.sshUser,
    sshPort: config.sshPort,
    agent: config.agentId,
    sessionId: config.sessionId,
    remoteCommand: config.remoteCommand || 'openclaw',
  }, null, 2);
}

export function SettingsRemoteInstancesPanel() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const routes = useIntercomStore((state) => state.routes);
  const localAgents = useIntercomStore((state) => state.localAgents);
  const localHost = useIntercomStore((state) => state.localHost);
  const defaultSessionId = useIntercomStore((state) => state.defaultSessionId);
  const selfConfig = useIntercomStore((state) => state.selfConfig);
  const hostReadiness = useIntercomStore((state) => state.hostReadiness);
  const loading = useIntercomStore((state) => state.loading);
  const installingProtocol = useIntercomStore((state) => state.installingProtocol);
  const preparingHost = useIntercomStore((state) => state.preparingHost);
  const settingHostAccess = useIntercomStore((state) => state.settingHostAccess);
  const fetchIntercom = useIntercomStore((state) => state.fetchIntercom);
  const fetchHostReadiness = useIntercomStore((state) => state.fetchHostReadiness);
  const installProtocol = useIntercomStore((state) => state.installProtocol);
  const prepareHost = useIntercomStore((state) => state.prepareHost);
  const setHostAccess = useIntercomStore((state) => state.setHostAccess);

  const sshRoutes = useMemo(
    () => routes.filter((route) => route.transport === 'ssh'),
    [routes],
  );
  const hostAccessEnabled = hostReadiness?.accessEnabled === true;

  useEffect(() => {
    void fetchIntercom();
  }, [fetchIntercom]);

  useEffect(() => {
    void fetchHostReadiness();
  }, [fetchHostReadiness]);

  const handleInstallProtocol = async () => {
    try {
      const result = await installProtocol();
      toast.success(t('remoteInstances.intercom.toasts.protocolInstalled', {
        updated: result.updated.length,
        skipped: result.skipped.length,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.protocolFailed'));
    }
  };

  const handlePrepareHost = async () => {
    try {
      const result = await prepareHost();
      if (result.success) {
        toast.success(t('remoteInstances.intercom.toasts.hostPrepared'));
      } else {
        toast.error(result.error || t('remoteInstances.intercom.toasts.hostPrepareFailed'));
      }
      void fetchIntercom({ force: true });
      void fetchHostReadiness();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.hostPrepareFailed'));
    }
  };

  const handleSetHostAccess = async (enabled: boolean) => {
    try {
      const result = await setHostAccess(enabled);
      if (result.success) {
        toast.success(t(enabled
          ? 'remoteInstances.intercom.toasts.hostAccessEnabled'
          : 'remoteInstances.intercom.toasts.hostAccessDisabled'));
      } else {
        toast.error(result.error || t('remoteInstances.intercom.toasts.hostAccessFailed'));
      }
      void fetchIntercom({ force: true });
      void fetchHostReadiness();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.hostAccessFailed'));
    }
  };

  const handleCopyConnectionInfo = async () => {
    if (!selfConfig) {
      toast.error(t('remoteInstances.intercom.toasts.connectionInfoCopyFailed'));
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) {
        toast.error(t('remoteInstances.intercom.toasts.connectionInfoCopyFailed'));
        return;
      }
      await navigator.clipboard.writeText(buildConnectionShareText(selfConfig));
      toast.success(t('remoteInstances.intercom.toasts.connectionInfoCopied'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('remoteInstances.intercom.toasts.connectionInfoCopyFailed'));
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSectionCard title={t('remoteInstances.intercom.settingsTitle')}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <div className="rounded-lg bg-white p-2 text-[#2563eb] shadow-sm dark:bg-background">
                <Router className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intercom.settingsHeading')}
                </p>
                <p className="mt-1 text-[12px] leading-6 text-[#64748b] dark:text-muted-foreground">
                  {t('remoteInstances.intercom.settingsDescription')}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => void fetchIntercom({ force: true })}
                disabled={loading}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                {t('remoteInstances.intercom.refresh')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => void handleInstallProtocol()}
                disabled={installingProtocol}
              >
                {installingProtocol ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                {t('remoteInstances.intercom.installProtocol')}
              </Button>
              <Button
                type="button"
                size="sm"
                className="gap-2"
                onClick={() => navigate('/remote-instances')}
              >
                <ExternalLink className="h-4 w-4" />
                {t('remoteInstances.intercom.openConsole')}
              </Button>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <section className="rounded-lg border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <MonitorCog className="h-4 w-4 text-[#64748b] dark:text-muted-foreground" />
                  <h4 className="text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                    {t('remoteInstances.intercom.selfTitle')}
                  </h4>
                </div>
                <Badge variant={hostReadiness?.ready ? 'success' : hostAccessEnabled ? 'warning' : 'secondary'}>
                  {!hostAccessEnabled
                    ? t('remoteInstances.intercom.hostAccessOff')
                    : hostReadiness?.ready
                      ? t('remoteInstances.intercom.hostReady')
                      : t('remoteInstances.intercom.hostNeedsSetup')}
                </Badge>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <div className="flex items-start gap-2">
                    {hostReadiness?.ready ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    )}
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-[#0f172a] dark:text-foreground">
                        {hostReadiness?.ready
                          ? t('remoteInstances.intercom.hostReadyDescription')
                          : t('remoteInstances.intercom.hostNeedsSetupDescription')}
                      </p>
                      <p className="mt-1 text-[11px] leading-5 text-[#64748b] dark:text-muted-foreground">
                        {hostReadiness?.needsAdmin
                          ? t('remoteInstances.intercom.hostPrepareAdminHint')
                          : t('remoteInstances.intercom.hostPrepareNoAdminHint')}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={hostReadiness?.ready ? 'outline' : 'default'}
                    className="mt-3 gap-2"
                    onClick={() => void handlePrepareHost()}
                    disabled={preparingHost || hostReadiness?.canPrepare === false}
                  >
                    {preparingHost ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                    {t('remoteInstances.intercom.prepareHost')}
                  </Button>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/[0.04] bg-[#f8fafc] px-3 py-2 dark:border-white/10 dark:bg-muted/40">
                    <div className="min-w-0">
                      <p className="text-[12px] font-semibold text-[#0f172a] dark:text-foreground">
                        {t('remoteInstances.intercom.hostAccessToggleLabel')}
                      </p>
                      <p className="mt-1 text-[11px] leading-5 text-[#64748b] dark:text-muted-foreground">
                        {hostAccessEnabled
                          ? t('remoteInstances.intercom.hostAccessToggleOnDescription')
                          : t('remoteInstances.intercom.hostAccessToggleOffDescription')}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {settingHostAccess ? <Loader2 className="h-4 w-4 animate-spin text-[#64748b]" /> : null}
                      <Badge variant={hostAccessEnabled ? 'success' : 'secondary'}>
                        {hostAccessEnabled
                          ? t('remoteInstances.intercom.hostAccessOn')
                          : t('remoteInstances.intercom.hostAccessOff')}
                      </Badge>
                      <Switch
                        checked={hostAccessEnabled}
                        onCheckedChange={(checked) => void handleSetHostAccess(checked)}
                        disabled={settingHostAccess || preparingHost || hostReadiness?.canPrepare === false}
                        aria-label={t('remoteInstances.intercom.hostAccessToggleLabel')}
                      />
                    </div>
                  </div>
                </div>
                {hostReadiness?.checks && hostReadiness.checks.length > 0 ? (
                  <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                    <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                      {t('remoteInstances.intercom.hostChecksLabel')}
                    </p>
                    <div className="mt-2 space-y-2">
                      {hostReadiness.checks.map((check) => (
                        <div key={check.id} className="flex items-start gap-2 text-[11px] leading-5">
                          {check.status === 'ok' ? (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                          ) : (
                            <AlertCircle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${check.status === 'warning' ? 'text-amber-600' : 'text-red-600'}`} />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium text-[#0f172a] dark:text-foreground">{check.title}</p>
                            <p className="text-[#64748b] dark:text-muted-foreground">{check.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.localHostLabel')}
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {localHost || 'local'}
                  </p>
                </div>
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.defaultSessionLabel')}
                  </p>
                  <p className="mt-1 font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {defaultSessionId || 'intercom'}
                  </p>
                </div>
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.localAgentsLabel')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {localAgents.length === 0 ? (
                      <Badge variant="secondary">{t('remoteInstances.intercom.noLocalAgents')}</Badge>
                    ) : null}
                    {localAgents.map((agent) => (
                      <Badge key={agent.id} variant="outline">
                        {agent.name || agent.id}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
              <div className="flex items-center gap-2">
                <Waypoints className="h-4 w-4 text-[#64748b] dark:text-muted-foreground" />
                <h4 className="text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intercom.selfShareTitle')}
                </h4>
              </div>
              <p className="mt-2 text-[12px] leading-5 text-[#64748b] dark:text-muted-foreground">
                {t('remoteInstances.intercom.selfShareDescription')}
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.selfHostToShareLabel')}
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {selfConfig?.host || localHost || 'local'}
                  </p>
                </div>
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.selfSshUserLabel')}
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {selfConfig?.sshUser || t('remoteInstances.intercom.unknownSshUser')}
                  </p>
                </div>
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.sshPortLabel')}
                  </p>
                  <p className="mt-1 font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {selfConfig?.sshPort ?? 22}
                  </p>
                </div>
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.agentIdLabel')}
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {selfConfig?.agentId || localAgents[0]?.id || 'main'}
                  </p>
                </div>
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.sessionLabel')}
                  </p>
                  <p className="mt-1 font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {selfConfig?.sessionId || defaultSessionId || 'intercom'}
                  </p>
                </div>
                <div className="rounded-lg bg-white px-3 py-3 dark:bg-background">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.remoteCommandLabel')}
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] text-[#0f172a] dark:text-foreground">
                    {selfConfig?.remoteCommand || 'openclaw'}
                  </p>
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-black/[0.04] bg-white px-3 py-3 dark:border-white/10 dark:bg-background">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                    {t('remoteInstances.intercom.selfRouteExampleLabel')}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2"
                    onClick={() => void handleCopyConnectionInfo()}
                    disabled={!selfConfig}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {t('remoteInstances.intercom.copyConnectionInfo')}
                  </Button>
                </div>
                <p className="mt-2 break-all font-mono text-[11px] leading-5 text-[#0f172a] dark:text-foreground">
                  {`ssh ${selfConfig ? selfRouteAddress(selfConfig) : (localHost || 'local')} -p ${selfConfig?.sshPort ?? 22}`}
                </p>
                <p className="mt-1 break-all font-mono text-[11px] leading-5 text-[#64748b] dark:text-muted-foreground">
                  {`${t('remoteInstances.intercom.routeIdLabel')}: ${selfConfig?.routeIdExample || localAgents[0]?.id || 'main'} / ${t('remoteInstances.intercom.displayNameLabel')}: ${selfConfig?.displayNameExample || localAgents[0]?.name || 'Main'}`}
                </p>
              </div>
            </section>
          </div>

          <section className="rounded-lg border border-black/5 bg-[#f8fafc] px-4 py-4 dark:border-white/10 dark:bg-muted/40">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-[#64748b] dark:text-muted-foreground" />
                <h4 className="text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intercom.configuredInstancesTitle')}
                </h4>
              </div>
              <Badge variant={sshRoutes.length > 0 ? 'success' : 'warning'}>
                {t('remoteInstances.intercom.instanceCount', { count: sshRoutes.length })}
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {sshRoutes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-black/10 bg-white px-3 py-4 text-[12px] leading-5 text-[#64748b] dark:border-white/10 dark:bg-background dark:text-muted-foreground">
                  {t('remoteInstances.intercom.emptyRoutes')}
                </div>
              ) : null}

              {sshRoutes.map((route) => (
                <div
                  key={route.id}
                  className="rounded-lg border border-black/[0.04] bg-white px-3 py-3 dark:border-white/10 dark:bg-background"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                        {route.displayName || route.id}
                      </p>
                      <p className="mt-1 break-all font-mono text-[11px] text-[#64748b] dark:text-muted-foreground">
                        ssh {routeAddress(route)} -p {routePort(route)}
                      </p>
                    </div>
                    <Badge variant={route.enabled ? 'success' : 'secondary'}>
                      {route.enabled ? t('remoteInstances.intercom.enabledLabel') : t('remoteInstances.intercom.disabledLabel')}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-2 text-[11px] text-[#64748b] dark:text-muted-foreground sm:grid-cols-3">
                    <span>{t('remoteInstances.intercom.agentIdLabel')}: {route.agent}</span>
                    <span>{t('remoteInstances.intercom.sessionLabel')}: {route.sessionId}</span>
                    <span>{t('remoteInstances.intercom.remoteCommandLabel')}: {route.remoteCommand || 'openclaw'}</span>
                    <span>{t('remoteInstances.intercom.sshPasswordLabel')}: {route.sshPasswordConfigured ? t('remoteInstances.intercom.passwordConfigured') : t('remoteInstances.intercom.passwordNotConfigured')}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </SettingsSectionCard>
    </div>
  );
}
