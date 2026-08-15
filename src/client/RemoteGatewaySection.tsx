import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconCopyOutline16,
  IconGlobeOutline14,
  IconPlayOutline16,
  IconRefreshOutline14,
  IconStopFill16,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './RemoteGatewaySection.module.css'
import { zh, type RemoteGatewayKey } from './locales.ts'

/** One direct gateway address returned by the Host plugin. */
export interface NetworkAddressInfo {
  family: 'IPv4' | 'IPv6'
  address: string
  scope: 'lan' | 'loopback' | 'public'
  interfaceName: string
  url: string
}

/** cloudflared readiness returned by the Host plugin. */
export interface EnvironmentStatus {
  state: 'ready' | 'missing' | 'installing' | 'error'
  source?: 'configured' | 'managed' | 'system'
  version?: string
  error?: string
  platform: string
  architecture: string
  managedSupported: boolean
  compatibility?: 'native' | 'x64-emulation'
}

/** Host runtime state rendered by this page. */
export interface RemoteGatewayStatus {
  enabled: boolean
  running: boolean
  listenHost: '127.0.0.1' | '0.0.0.0' | '::'
  port: number
  username: string
  password: string
  coreHost: string
  corePort: number
  coreLoopback: boolean
  activeConnections: number
  addresses: NetworkAddressInfo[]
  environment: EnvironmentStatus
  tunnel: {
    state: 'stopped' | 'starting' | 'running' | 'error'
    publicUrl?: string
    error?: string
  }
}

interface ApiResponse {
  success: boolean
  data?: RemoteGatewayStatus
  error?: string
}

/** Business props injected by the Client plugin. */
export interface RemoteGatewaySectionInjected {
  t: (key: RemoteGatewayKey) => string
}

/** Settings-shell owner props plus remote gateway business props. */
export type RemoteGatewaySectionProps = PropsRuntime<'settings.section'> & RemoteGatewaySectionInjected

/** Remote gateway, managed environment, credential, and address controls. */
export function RemoteGatewaySection({ t = key => zh[key] }: RemoteGatewaySectionProps) {
  const root = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<RemoteGatewayStatus | null>(null)
  const [busy, setBusy] = useState<string | null>('load')
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [port, setPort] = useState('3088')
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    const dialog = root.current?.closest('[role="dialog"]')
    if (!(dialog instanceof HTMLElement)) return
    dialog.dataset.dshRemoteGatewayDialog = 'true'
    return () => { delete dialog.dataset.dshRemoteGatewayDialog }
  }, [])

  const adopt = useCallback((next: RemoteGatewayStatus) => {
    setStatus(next)
    setUsername(next.username)
    setPassword(next.password)
    setPort(String(next.port))
  }, [])

  const request = useCallback(async (path: string, init?: RequestInit): Promise<RemoteGatewayStatus> => {
    const response = await fetch(path, init)
    const body = await response.json() as RemoteGatewayStatus | ApiResponse
    if (!response.ok) {
      const wrapped = 'success' in body ? body : undefined
      if (wrapped?.data !== undefined) adopt(wrapped.data)
      throw new Error(wrapped?.error ?? `HTTP ${response.status}`)
    }
    if ('success' in body) {
      if (body.data === undefined) throw new Error(body.error ?? 'Missing status response')
      return body.data
    }
    return body
  }, [adopt])

  const refresh = useCallback(async () => {
    setBusy(current => current ?? 'refresh')
    try {
      adopt(await request('/api/remote-gateway/status'))
      setNotice(null)
    } catch (error) {
      setNotice({ kind: 'error', text: `${t('loadError')} ${message(error)}` })
    } finally {
      setBusy(null)
    }
  }, [adopt, request, t])

  useEffect(() => { void refresh() }, [refresh])

  const act = useCallback(async (name: string, path: string, init: RequestInit = { method: 'POST' }) => {
    setBusy(name)
    setNotice(null)
    try {
      adopt(await request(path, init))
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: message(error) })
      return false
    } finally {
      setBusy(null)
    }
  }, [adopt, request])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await act('save', '/api/remote-gateway/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, port: Number(port) }),
    })
    if (ok) setNotice({ kind: 'success', text: t('saveSuccess') })
  }

  const toggleGateway = async () => {
    await act('gateway', '/api/remote-gateway/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !status?.running }),
    })
  }

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(value)
    window.setTimeout(() => setCopied(current => current === value ? null : current), 1800)
  }

  const directAddresses = useMemo(() => status?.addresses.filter(address => address.scope !== 'loopback') ?? [], [status])
  const publicUrl = status?.tunnel.publicUrl
  const running = status?.running === true
  const environment = status?.environment
  const needsSetup = environment?.state !== 'ready'
  const environmentLabel = environment === undefined ? t('environmentMissing') : t(environmentStateKey(environment.state))
  const environmentMeta = environment === undefined ? '' : [
    `${environment.platform}/${environment.architecture}`,
    environment.source === undefined ? undefined : t(sourceKey(environment.source)),
    environment.version,
    environment.compatibility === 'x64-emulation' ? t('emulatedBuild') : t('nativeBuild'),
  ].filter(Boolean).join(' · ')

  return (
    <div ref={root} className={css.section}>
      <header className={css.pageHeader}>
        <div>
          <h2 className={css.title}>{t('title')}</h2>
          <p className={css.intro}>{t('intro')}</p>
        </div>
        <div className={running ? css.statusRunning : css.statusStopped}>
          <span className={css.statusDot} />
          <span>{running ? t('gatewayRunning') : t('gatewayStopped')}</span>
        </div>
      </header>

      {status !== null && !status.coreLoopback && <p className={css.warning} role="alert">{t('coreWarning')}</p>}
      {notice !== null && <p className={notice.kind === 'error' ? css.error : css.success} role="status">{notice.text}</p>}

      <section className={css.publicCard}>
        <div className={css.cardHeader}>
          <div className={css.cardTitleGroup}>
            <span className={css.featureIcon}><IconGlobeOutline14 size={18} /></span>
            <div>
              <h3 className={css.cardTitle}>{t('publicTitle')}</h3>
              <p className={css.cardIntro}>{t('publicIntro')}</p>
            </div>
          </div>
          <span className={css.connectionCount}>{status?.activeConnections ?? 0} {t('connections')}</span>
        </div>

        <div className={css.environmentRow}>
          <div className={css.environmentText}>
            <span className={environment?.state === 'ready' ? css.environmentReady : environment?.state === 'error' ? css.environmentFailed : css.environmentPending}>
              <span />{environmentLabel}
            </span>
            <small>{environmentMeta}</small>
          </div>
          <Button variant="ghost" size="sm" icon={<IconRefreshOutline14 />} disabled={busy !== null} onClick={() => { void act('environment', '/api/remote-gateway/environment/refresh') }}>{t('refreshEnvironment')}</Button>
        </div>
        {environment?.managedSupported === false && environment.state !== 'ready' && <p className={css.environmentHelp}>{t('unsupportedPlatform')}</p>}

        <div className={css.tunnelPanel}>
          {status?.tunnel.state === 'running' && publicUrl !== undefined ? (
            <>
              <div className={css.publicUrlBlock}>
                <span className={css.liveLabel}><span />HTTPS</span>
                <code className={css.publicUrl}>{publicUrl}</code>
              </div>
              <div className={css.actionRow}>
                <Button variant="outline" size="sm" icon={<IconCopyOutline16 size={14} />} onClick={() => { void copy(publicUrl) }}>
                  {copied === publicUrl ? t('copied') : t('copy')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => window.open(publicUrl, '_blank', 'noopener,noreferrer')}>{t('open')}</Button>
                <Button size="sm" icon={<IconStopFill16 size={13} />} disabled={busy !== null} onClick={() => { void act('tunnel', '/api/remote-gateway/tunnel/stop') }}>{t('stopTunnel')}</Button>
              </div>
            </>
          ) : (
            <>
              <div className={css.tunnelEmpty}>
                <strong>{status?.tunnel.state === 'starting' ? t('tunnelStarting') : status?.tunnel.state === 'error' ? t('tunnelError') : t('tunnelStopped')}</strong>
                {status?.tunnel.error !== undefined && <span>{status.tunnel.error}</span>}
                {environment?.error !== undefined && <span>{environment.error}</span>}
              </div>
              <Button variant="primary" icon={<IconPlayOutline16 size={15} />} disabled={busy !== null || environment?.managedSupported === false} onClick={() => { void act('tunnel', '/api/remote-gateway/tunnel/start') }}>
                {busy === 'tunnel' ? t('settingUp') : needsSetup ? t('setupAndStart') : t('startTunnel')}
              </Button>
            </>
          )}
        </div>
        <p className={css.note}>{t('quickTunnelNote')}</p>
      </section>

      <section className={css.card}>
        <div className={css.cardHeader}>
          <div>
            <h3 className={css.cardTitle}>{t('credentialsTitle')}</h3>
            <p className={css.cardIntro}>{t('credentialsIntro')}</p>
          </div>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { void toggleGateway() }}>
            {running ? t('stopGateway') : t('startGateway')}
          </Button>
        </div>
        <form className={css.form} onSubmit={event => { void save(event) }}>
          <label className={css.field}><span>{t('username')}</span><Input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label>
          <label className={css.field}><span>{t('password')}</span><span className={css.passwordField}><Input type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" minLength={10} required /><button type="button" onClick={() => setShowPassword(value => !value)}>{showPassword ? t('hide') : t('show')}</button></span></label>
          <label className={css.field}><span>{t('port')}</span><Input type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} required /></label>
          <div className={css.formAction}><Button variant="primary" type="submit" disabled={busy !== null}>{busy === 'save' ? t('saving') : t('save')}</Button></div>
        </form>
      </section>

      <section className={css.card}>
        <div className={css.cardHeader}>
          <div>
            <h3 className={css.cardTitle}>{t('directTitle')}</h3>
            <p className={css.cardIntro}>{t('directIntro')}</p>
          </div>
          <Button variant="ghost" size="sm" icon={<IconRefreshOutline14 />} disabled={busy !== null} onClick={() => { void refresh() }}>{t('refresh')}</Button>
        </div>
        {directAddresses.length === 0 ? <p className={css.empty}>{t('noAddresses')}</p> : (
          <ul className={css.addresses}>
            {directAddresses.map(address => (
              <li key={`${address.interfaceName}:${address.address}`}>
                <span className={address.scope === 'public' ? css.publicBadge : css.lanBadge}>{address.scope === 'public' ? t('publicIpv6') : t('lan')}</span>
                <span className={css.addressBody}><code>{address.url}</code><small>{address.interfaceName} · {address.family}</small></span>
                <Button variant="ghost" size="sm" icon={<IconCopyOutline16 size={14} />} onClick={() => { void copy(address.url) }}>{copied === address.url ? t('copied') : t('copy')}</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function environmentStateKey(state: EnvironmentStatus['state']): RemoteGatewayKey {
  if (state === 'ready') return 'environmentReady'
  if (state === 'installing') return 'environmentInstalling'
  if (state === 'error') return 'environmentError'
  return 'environmentMissing'
}

function sourceKey(source: NonNullable<EnvironmentStatus['source']>): RemoteGatewayKey {
  if (source === 'managed') return 'sourceManaged'
  if (source === 'configured') return 'sourceConfigured'
  return 'sourceSystem'
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
