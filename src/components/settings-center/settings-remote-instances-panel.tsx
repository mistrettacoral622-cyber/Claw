import { useEffect, useMemo } from 'react';
import {
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
import { useIntercomStore, type IntercomRoute } from '@/stores/intercom';
import { toast } from '@/lib/toast';

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

export function SettingsRemoteInstancesPanel() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const routes = useIntercomStore((state) => state.routes);
  const localAgents = useIntercomStore((state) => state.localAgents);
  const localHost = useIntercomStore((state) => state.localHost);
  const defaultSessionId = useIntercomStore((state) => state.defaultSessionId);
  const selfConfig = useIntercomStore((state) => state.selfConfig);
  const loading = useIntercomStore((state) => state.loading);
  const installingProtocol = useIntercomStore((state) => state.installingProtocol);
  const fetchIntercom = useIntercomStore((state) => state.fetchIntercom);
  const installProtocol = useIntercomStore((state) => state.installProtocol);

  const sshRoutes = useMemo(
    () => routes.filter((route) => route.transport === 'ssh'),
    [routes],
  );

  useEffect(() => {
    void fetchIntercom();
  }, [fetchIntercom]);

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
              <div className="flex items-center gap-2">
                <MonitorCog className="h-4 w-4 text-[#64748b] dark:text-muted-foreground" />
                <h4 className="text-[13px] font-semibold text-[#0f172a] dark:text-foreground">
                  {t('remoteInstances.intercom.selfTitle')}
                </h4>
              </div>
              <div className="mt-4 space-y-3">
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
                <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-[#64748b] dark:text-muted-foreground">
                  {t('remoteInstances.intercom.selfRouteExampleLabel')}
                </p>
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
