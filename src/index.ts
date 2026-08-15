/**
 * Authenticated HTTP/WebSocket gateway and managed Cloudflare Quick Tunnel
 * controller for DeepSeek Harness Web.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as requestHttp } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions, Server, ServerResponse } from 'node:http'
import { request as requestHttps } from 'node:https'
import net from 'node:net'
import type { Socket } from 'node:net'
import os from 'node:os'
import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { CloudflaredManager } from './cloudflared.ts'
import type { CloudflaredEnvironmentStatus } from './cloudflared.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteGateway: RemoteGatewayService
  }
}

/** One direct address for the authenticated gateway. */
export interface NetworkAddressInfo {
  family: 'IPv4' | 'IPv6'
  address: string
  scope: 'lan' | 'loopback' | 'public'
  interfaceName: string
  url: string
}

/** Quick Tunnel lifecycle published to the settings page. */
export interface TunnelStatus {
  state: 'stopped' | 'starting' | 'running' | 'error'
  publicUrl?: string
  error?: string
}

/** Runtime status safe to expose to the local settings client. */
export interface RemoteGatewayStatus {
  enabled: boolean
  running: boolean
  listenHost: RemoteGatewayConfig['listenHost']
  port: number
  username: string
  password: string
  coreHost: string
  corePort: number
  coreLoopback: boolean
  activeConnections: number
  bannedIps: string[]
  addresses: NetworkAddressInfo[]
  environment: CloudflaredEnvironmentStatus
  tunnel: TunnelStatus
}

/** Bundle configuration for the remote gateway. */
export interface RemoteGatewayConfig {
  /** Start the authenticated gateway with the plugin. */
  enabled: boolean
  /** Gateway bind address; `::` accepts IPv4 and IPv6 where dual stack is available. */
  listenHost: '127.0.0.1' | '0.0.0.0' | '::'
  /** Gateway port. */
  port: number
  /** Login username. */
  username: string
  /** Initial password; an empty value generates a random password at boot. */
  password: string
  /** Failed logins before a source address is temporarily blocked. */
  maxFailedAttempts: number
  /** Temporary block duration. */
  banDurationMinutes: number
  /** cloudflared executable name or absolute path. */
  cloudflaredPath: string
  /** Install the pinned official cloudflared build when none is available. */
  autoInstallCloudflared: boolean
  /** Start a Quick Tunnel after the gateway binds. */
  autoStartQuickTunnel: boolean
  /** Connector transport used between cloudflared and Cloudflare. */
  tunnelProtocol: 'auto' | 'http2' | 'quic'
  /** Plugin-owned state directory; empty uses `$DSH_HOME/tools/dsh-remote-gateway`. */
  dataDirectory: string
  /** Time allowed for cloudflared to publish its public URL. */
  tunnelStartupTimeoutMs: number
  /** Number of Quick Tunnel allocations attempted before startup fails. */
  tunnelStartupAttempts: number
  /** Time allowed for the allocated public login page to become reachable. */
  tunnelReachabilityTimeoutMs: number
  /** Grace period used when stopping the cloudflared process tree. */
  processGraceMs: number
  /** Time allowed for either supported DSH Web server service name to appear. */
  webServerStartupTimeoutMs: number
}

interface FailedAttempt {
  count: number
  banUntil: number
}

interface UpdateInput {
  enabled?: boolean
  password?: string
  port?: number
  username?: string
}

interface WebServerRuntime {
  host: string
  port: number
  register(route: {
    kind: 'exact'
    path: string
    handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
  }): () => void
}

const COOKIE_NAME = 'dsh_remote_gateway_session'
const LOGIN_PATH = '/__dsh_remote_gateway/login'
const LOGOUT_PATH = '/__dsh_remote_gateway/logout'
const MAX_BODY_BYTES = 16 * 1024
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/** Authenticated proxy service controlled from the Harness settings page. */
export class RemoteGatewayService extends Service {
  static inject = ['subprocess']

  static Config = z.object({
    enabled: z.boolean().default(true).description('Start the authenticated gateway'),
    listenHost: z.union([z.const('127.0.0.1'), z.const('0.0.0.0'), z.const('::')]).default('::')
      .description('Gateway bind address'),
    port: z.natural().max(65535).default(3088).description('Gateway port'),
    username: z.string().default('admin').description('Login username'),
    password: z.string().default('').description('Initial password; empty generates one at boot'),
    maxFailedAttempts: z.natural().min(1).default(5).description('Failed logins before a temporary block'),
    banDurationMinutes: z.natural().min(1).default(15).description('Temporary block duration'),
    cloudflaredPath: z.string().default('cloudflared').description('cloudflared executable name or path'),
    autoInstallCloudflared: z.boolean().default(true).description('Install a verified cloudflared build when missing'),
    autoStartQuickTunnel: z.boolean().default(false).description('Start a Quick Tunnel at boot'),
    tunnelProtocol: z.union([z.const('auto'), z.const('http2'), z.const('quic')]).default('http2')
      .description('cloudflared connector transport'),
    dataDirectory: z.string().default('').description('Managed tool directory; empty uses the DSH home'),
    tunnelStartupTimeoutMs: z.natural().min(1).default(30_000).description('Quick Tunnel startup timeout'),
    tunnelStartupAttempts: z.natural().min(1).max(10).default(3).description('Quick Tunnel allocation attempts'),
    tunnelReachabilityTimeoutMs: z.natural().min(1).default(10_000)
      .description('Public login-page reachability timeout'),
    processGraceMs: z.natural().min(1).default(5_000).description('cloudflared shutdown grace period'),
    webServerStartupTimeoutMs: z.natural().min(1).default(30_000).description('DSH Web server discovery timeout'),
  })

  private server: Server | undefined
  private readonly clientSockets = new Set<Duplex>()
  private readonly upstreamSockets = new Set<Socket>()
  private readonly sessions = new Set<string>()
  private readonly failedAttempts = new Map<string, FailedAttempt>()
  private readonly cloudflared: CloudflaredManager
  private webServer!: WebServerRuntime
  private activeEnabled: boolean
  private activePort: number
  private activeUsername: string
  private activePassword: string
  private tunnel: TunnelStatus = { state: 'stopped' }
  private tunnelHandle: SubprocessHandle | undefined
  private tunnelReaders: ReadlineInterface[] = []
  private tunnelGeneration = 0
  private tunnelStart: Promise<RemoteGatewayStatus> | undefined
  /** Test hooks for external reachability without changing the production request path. */
  internals: { probePublicGateway?: (url: string, signal: AbortSignal) => Promise<number> } = {}

  constructor(ctx: Context, private readonly config: RemoteGatewayConfig) {
    super(ctx, 'remoteGateway')
    this.activeEnabled = config.enabled
    this.activePort = config.port
    this.activeUsername = config.username.trim() || 'admin'
    this.activePassword = config.password.trim() || randomBytes(15).toString('base64url')
    this.cloudflared = new CloudflaredManager({
      configuredPath: config.cloudflaredPath,
      ...config.dataDirectory.trim() === '' ? {} : { dataDirectory: config.dataDirectory },
      resolveExecutable: command => ctx.subprocess.resolveExecutable(command),
    })
  }

  /** Return current state without exposing session tokens or local executable paths. */
  getStatus(): RemoteGatewayStatus {
    this.expireBans()
    return {
      enabled: this.activeEnabled,
      running: this.server?.listening === true,
      listenHost: this.config.listenHost,
      port: this.activePort,
      username: this.activeUsername,
      password: this.activePassword,
      coreHost: this.webServer.host,
      corePort: this.webServer.port,
      coreLoopback: this.webServer.host === '127.0.0.1' || this.webServer.host === '::1',
      activeConnections: this.clientSockets.size,
      bannedIps: [...this.failedAttempts.entries()]
        .filter(([, attempt]) => attempt.banUntil > Date.now())
        .map(([ip]) => ip)
        .sort(),
      addresses: this.server?.listening === true ? this.scanNetworkAddresses() : [],
      environment: this.cloudflared.getStatus(),
      tunnel: { ...this.tunnel },
    }
  }

  /** Refresh cloudflared discovery and return the complete gateway status. */
  async refreshEnvironment(): Promise<RemoteGatewayStatus> {
    await this.cloudflared.probe()
    return this.getStatus()
  }

  /** Install the verified managed cloudflared build and return the complete status. */
  async installCloudflared(): Promise<RemoteGatewayStatus> {
    await this.cloudflared.ensureInstalled()
    return this.getStatus()
  }

  /** Apply a live gateway update and invalidate sessions after credential changes. */
  async update(update: UpdateInput): Promise<RemoteGatewayStatus> {
    const nextPort = update.port ?? this.activePort
    if (!Number.isSafeInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
      throw new TypeError('port must be an integer from 1 through 65535')
    }
    const nextUsername = update.username?.trim() || this.activeUsername
    const nextPassword = update.password?.trim() || this.activePassword
    if (nextUsername.length === 0) throw new TypeError('username must not be empty')
    if (nextPassword.length < 10) throw new TypeError('password must contain at least 10 characters')

    const wasTunnelActive = this.tunnel.state === 'running' || this.tunnel.state === 'starting'
    const needsGatewayRestart = nextPort !== this.activePort
    const credentialsChanged = nextUsername !== this.activeUsername || nextPassword !== this.activePassword
    const nextEnabled = update.enabled ?? this.activeEnabled

    if (wasTunnelActive && (needsGatewayRestart || !nextEnabled)) await this.stopQuickTunnel()
    this.activePort = nextPort
    this.activeUsername = nextUsername
    this.activePassword = nextPassword
    this.activeEnabled = nextEnabled
    if (credentialsChanged) this.sessions.clear()

    if (!nextEnabled) {
      await this.stopGateway()
      return this.getStatus()
    }
    if (needsGatewayRestart || this.server?.listening !== true) await this.restartGateway()
    if (wasTunnelActive && needsGatewayRestart) await this.startQuickTunnel()
    return this.getStatus()
  }

  /** Start or join the current one-click setup and Quick Tunnel operation. */
  async startQuickTunnel(): Promise<RemoteGatewayStatus> {
    if (this.tunnel.state === 'running') return this.getStatus()
    if (this.tunnelStart !== undefined) return this.tunnelStart
    const operation = this.startQuickTunnelOwned()
    this.tunnelStart = operation
    try {
      return await operation
    } finally {
      if (this.tunnelStart === operation) this.tunnelStart = undefined
    }
  }

  /** Stop cloudflared and wait for its process tree to exit. */
  async stopQuickTunnel(): Promise<RemoteGatewayStatus> {
    ++this.tunnelGeneration
    const handle = this.tunnelHandle
    this.tunnelHandle = undefined
    this.closeTunnelReaders()
    if (handle !== undefined) {
      handle.terminate()
      await handle.done.catch(() => undefined)
      await handle.waitForExit()
    }
    this.tunnel = { state: 'stopped' }
    return this.getStatus()
  }

  /** Return sorted public, LAN, and loopback addresses for the active gateway. */
  scanNetworkAddresses(): NetworkAddressInfo[] {
    const results: NetworkAddressInfo[] = []
    for (const [interfaceName, interfaces] of Object.entries(os.networkInterfaces())) {
      for (const address of interfaces ?? []) {
        const family = address.family === 'IPv6' ? 'IPv6' : 'IPv4'
        const scope = address.internal
          ? 'loopback'
          : family === 'IPv4' || isPrivateIpv6(address.address) ? 'lan' : 'public'
        const formattedAddress = family === 'IPv6' ? `[${stripZone(address.address)}]` : address.address
        results.push({
          family,
          address: address.address,
          scope,
          interfaceName,
          url: `http://${formattedAddress}:${this.activePort}`,
        })
      }
    }
    const rank = { public: 0, lan: 1, loopback: 2 } as const
    return results.sort((left, right) => rank[left.scope] - rank[right.scope]
      || left.family.localeCompare(right.family)
      || left.interfaceName.localeCompare(right.interfaceName))
  }

  /** Start the authenticated gateway if it is not already listening. */
  async startGateway(): Promise<void> {
    if (this.server?.listening === true) return
    const server = createServer((request, response) => {
      void this.handleGatewayRequest(request, response).catch((error: unknown) => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        if (response.headersSent) response.destroy()
        else sendText(response, 502, 'Remote gateway request failed.')
      })
    })
    this.server = server
    server.on('connection', socket => {
      this.clientSockets.add(socket)
      socket.once('close', () => this.clientSockets.delete(socket))
    })
    server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
    try {
      await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(this.activePort, this.config.listenHost, () => {
          server.off('error', reject)
          server.on('error', error => this.ctx.logger.warn(error))
          resolvePromise()
        })
      })
    } catch (error) {
      this.server = undefined
      throw error
    }
  }

  /** Stop the gateway and close every proxied or upgraded socket it owns. */
  async stopGateway(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    for (const socket of this.upstreamSockets) socket.destroy()
    for (const socket of this.clientSockets) socket.destroy()
    this.upstreamSockets.clear()
    this.clientSockets.clear()
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  }

  async [Service.init](): Promise<void> {
    this.webServer = await waitForWebServer(this.ctx, this.config.webServerStartupTimeoutMs)
    this.registerApiRoutes()
    await this.cloudflared.probe()
    await this.ctx.effect(async () => {
      if (this.activeEnabled) await this.startGateway()
      if (this.config.autoStartQuickTunnel) await this.startQuickTunnel()
      return async () => {
        await this.stopQuickTunnel()
        await this.stopGateway()
      }
    }, 'dsh-remote-gateway: gateway and tunnel')
  }

  private async startQuickTunnelOwned(): Promise<RemoteGatewayStatus> {
    if (this.server?.listening !== true) {
      this.activeEnabled = true
      await this.startGateway()
    }
    await this.stopQuickTunnel()

    let executable: string
    try {
      if (this.config.autoInstallCloudflared) {
        executable = await this.cloudflared.ensureInstalled()
      } else {
        const environment = await this.cloudflared.probe()
        executable = this.cloudflared.getExecutable() ?? ''
        if (environment.state !== 'ready' || executable === '') {
          throw new Error(environment.error ?? 'cloudflared is missing and automatic installation is disabled')
        }
      }
    } catch (error) {
      const failure = `cloudflared is not ready: ${message(error)}`
      this.tunnel = { state: 'error', error: failure }
      throw new Error(failure, { cause: error })
    }

    let lastError: unknown
    let attempted = 0
    for (let attempt = 1; attempt <= this.config.tunnelStartupAttempts; attempt += 1) {
      attempted = attempt
      try {
        const publicUrl = await this.startQuickTunnelAttempt(executable)
        await this.verifyPublicGateway(publicUrl)
        this.tunnel = { state: 'running', publicUrl }
        return this.getStatus()
      } catch (error) {
        lastError = describeQuickTunnelAllocationFailure(error)
        await this.discardCurrentTunnelAttempt()
        if (isQuickTunnelAllocationRejected(error)) break
      }
    }
    const failure = `Quick Tunnel failed after ${attempted} ${attempted === 1 ? 'attempt' : 'attempts'}: ${message(lastError)}`
    this.tunnel = { state: 'error', error: failure }
    throw new Error(failure, { cause: lastError })
  }

  private async startQuickTunnelAttempt(executable: string): Promise<string> {
    const generation = ++this.tunnelGeneration
    this.tunnel = { state: 'starting' }
    const protocolArgs = this.config.tunnelProtocol === 'auto' ? [] : ['--protocol', this.config.tunnelProtocol]
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, 'tunnel', '--no-autoupdate', ...protocolArgs, '--url', `http://127.0.0.1:${this.activePort}`],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.config.processGraceMs,
    })
    this.tunnelHandle = handle

    const ready = new Promise<string>((resolvePromise, reject) => {
      let settled = false
      let publicUrl: string | undefined
      let registered = false
      let lastFailureLine: string | undefined
      let timer: ReturnType<typeof setTimeout>
      const finish = (result: { error: Error } | { url: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if ('error' in result) reject(result.error)
        else resolvePromise(result.url)
      }
      const inspectLine = (line: string): void => {
        const match = line.match(QUICK_TUNNEL_URL)
        if (match?.[0] !== undefined) publicUrl = match[0]
        if (line.includes('Registered tunnel connection')) registered = true
        if (/\bERR\b|\bfailed\b|error=/i.test(line)) lastFailureLine = line.trim().slice(-512)
        if (publicUrl !== undefined && registered) finish({ url: publicUrl })
      }
      for (const stream of [handle.stdout, handle.stderr]) {
        if (stream === undefined) continue
        const reader = createInterface({ input: stream })
        this.tunnelReaders.push(reader)
        reader.on('line', inspectLine)
      }
      timer = setTimeout(() => {
        finish({ error: new Error(`cloudflared did not publish a URL within ${this.config.tunnelStartupTimeoutMs}ms`) })
      }, this.config.tunnelStartupTimeoutMs)
      void handle.done.then(outcome => {
        if (!settled) finish({ error: new Error(lastFailureLine
          ?? `cloudflared exited before becoming ready (exit ${outcome.exitCode ?? outcome.signal ?? 'unknown'})`) })
      }, (error: unknown) => {
        finish({ error: new Error(`cloudflared failed to start: ${message(error)}`, { cause: error }) })
      })
    })

    void handle.done.then(outcome => {
      if (this.tunnelGeneration !== generation || this.tunnelHandle !== handle) return
      this.closeTunnelReaders()
      this.tunnelHandle = undefined
      if (this.tunnel.state !== 'stopped') {
        this.tunnel = { state: 'error', error: `cloudflared stopped (exit ${outcome.exitCode ?? outcome.signal ?? 'unknown'})` }
      }
    }, (error: unknown) => {
      if (this.tunnelGeneration !== generation || this.tunnelHandle !== handle) return
      this.closeTunnelReaders()
      this.tunnelHandle = undefined
      this.tunnel = { state: 'error', error: message(error) }
    })

    const publicUrl = await ready
    if (this.tunnelGeneration !== generation || this.tunnelHandle !== handle) {
      throw new Error('cloudflared startup was superseded')
    }
    return publicUrl
  }

  private async verifyPublicGateway(publicUrl: string): Promise<void> {
    try {
      const signal = AbortSignal.timeout(this.config.tunnelReachabilityTimeoutMs)
      const target = `${publicUrl}${LOGIN_PATH}`
      const status = await (this.internals.probePublicGateway
        ?? (process.platform === 'win32'
          ? (url, requestSignal) => this.probePublicGatewayWithCurl(url, requestSignal)
          : probePublicGateway))(target, signal)
      if (status !== 200) throw new Error(`public login page returned HTTP ${status}`)
    } catch (error) {
      throw new Error(`public login page is unreachable: ${message(error)}`, { cause: error })
    }
  }

  private async probePublicGatewayWithCurl(url: string, signal: AbortSignal): Promise<number> {
    const executable = await this.ctx.subprocess.resolveExecutable('curl.exe', undefined, signal)
    const timeoutSeconds = String(Math.max(1, Math.ceil(this.config.tunnelReachabilityTimeoutMs / 1_000)))
    const handle = this.ctx.subprocess.spawn({
      argv: [
        executable,
        '--silent',
        '--show-error',
        '--ipv4',
        '--proto',
        '=https',
        '--output',
        'NUL',
        '--write-out',
        '%{http_code}',
        '--connect-timeout',
        timeoutSeconds,
        '--max-time',
        timeoutSeconds,
        url,
      ],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.config.processGraceMs,
      signal,
    })
    let stdout = ''
    let stderr = ''
    handle.stdout?.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-32) })
    handle.stderr?.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-512) })
    const outcome = await handle.done
    await handle.waitForExit()
    signal.throwIfAborted()
    if (outcome.exitCode !== 0) throw new Error(stderr.trim() || `curl exited with code ${outcome.exitCode ?? outcome.signal ?? 'unknown'}`)
    const status = Number(stdout.trim())
    if (!Number.isSafeInteger(status)) throw new Error(`curl returned an invalid HTTP status: ${stdout.trim()}`)
    return status
  }

  private async discardCurrentTunnelAttempt(): Promise<void> {
    const handle = this.tunnelHandle
    if (handle === undefined) return
    ++this.tunnelGeneration
    this.tunnelHandle = undefined
    this.closeTunnelReaders()
    handle.terminate()
    await handle.done.catch(() => undefined)
    await handle.waitForExit()
  }

  private async restartGateway(): Promise<void> {
    await this.stopGateway()
    await this.startGateway()
  }

  private registerApiRoutes(): void {
    this.ctx.effect(() => {
      const disposers = [
        this.webServer.register({ kind: 'exact', path: '/api/remote-gateway/status', handler: (req, res) => this.handleStatus(req, res) }),
        this.webServer.register({ kind: 'exact', path: '/api/remote-gateway/update', handler: (req, res) => this.handleUpdate(req, res) }),
        this.webServer.register({ kind: 'exact', path: '/api/remote-gateway/environment/refresh', handler: (req, res) => this.handleEnvironmentRefresh(req, res) }),
        this.webServer.register({ kind: 'exact', path: '/api/remote-gateway/environment/install', handler: (req, res) => this.handleEnvironmentInstall(req, res) }),
        this.webServer.register({ kind: 'exact', path: '/api/remote-gateway/tunnel/start', handler: (req, res) => this.handleTunnelStart(req, res) }),
        this.webServer.register({ kind: 'exact', path: '/api/remote-gateway/tunnel/stop', handler: (req, res) => this.handleTunnelStop(req, res) }),
      ]
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'dsh-remote-gateway: control routes')
  }

  private async handleStatus(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (requireMethod(request, response, 'GET')) sendJson(response, 200, this.getStatus())
  }

  private async handleUpdate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requireMethod(request, response, 'POST')) return
    try {
      const body = JSON.parse(await readBody(request)) as UpdateInput
      sendJson(response, 200, { success: true, data: await this.update(body) })
    } catch (error) {
      sendJson(response, 400, { success: false, error: message(error) })
    }
  }

  private async handleEnvironmentRefresh(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requireMethod(request, response, 'POST')) return
    try {
      sendJson(response, 200, { success: true, data: await this.refreshEnvironment() })
    } catch (error) {
      sendJson(response, 503, { success: false, error: message(error), data: this.getStatus() })
    }
  }

  private async handleEnvironmentInstall(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requireMethod(request, response, 'POST')) return
    try {
      sendJson(response, 200, { success: true, data: await this.installCloudflared() })
    } catch (error) {
      sendJson(response, 503, { success: false, error: message(error), data: this.getStatus() })
    }
  }

  private async handleTunnelStart(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requireMethod(request, response, 'POST')) return
    try {
      sendJson(response, 200, { success: true, data: await this.startQuickTunnel() })
    } catch (error) {
      sendJson(response, 503, { success: false, error: message(error), data: this.getStatus() })
    }
  }

  private async handleTunnelStop(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (requireMethod(request, response, 'POST')) {
      sendJson(response, 200, { success: true, data: await this.stopQuickTunnel() })
    }
  }

  private async handleGatewayRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = requestPath(request)
    const clientIp = cleanIp(request.socket.remoteAddress)
    if (path === LOGIN_PATH) {
      await this.handleLogin(request, response, clientIp)
      return
    }
    if (path === LOGOUT_PATH) {
      this.sessions.delete(readCookie(request.headers.cookie, COOKIE_NAME) ?? '')
      response.writeHead(303, { location: LOGIN_PATH, 'set-cookie': expiredCookie() })
      response.end()
      return
    }
    if (!this.isAuthorized(request)) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        response.writeHead(303, { location: LOGIN_PATH })
        response.end()
      } else {
        sendText(response, 401, 'Authentication required.')
      }
      return
    }
    this.proxyHttp(request, response, clientIp)
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse, clientIp: string): Promise<void> {
    if (this.isBanned(clientIp)) {
      sendLoginPage(response, 'Too many failed attempts. Try again later. / 尝试次数过多，请稍后再试。', 403)
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      sendLoginPage(response)
      return
    }
    if (request.method !== 'POST') {
      sendText(response, 405, 'Method not allowed.')
      return
    }
    const form = new URLSearchParams(await readBody(request))
    const username = form.get('username') ?? ''
    const password = form.get('password') ?? ''
    if (!safeEqual(username, this.activeUsername) || !safeEqual(password, this.activePassword)) {
      this.recordFailure(clientIp)
      sendLoginPage(response, 'Incorrect username or password. / 用户名或密码错误。', 401)
      return
    }
    this.failedAttempts.delete(clientIp)
    const token = randomBytes(32).toString('base64url')
    this.sessions.add(token)
    response.writeHead(303, {
      location: '/',
      'set-cookie': sessionCookie(token, forwardedProto(request.headers) === 'https'),
      'cache-control': 'no-store',
    })
    response.end()
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const token = readCookie(request.headers.cookie, COOKIE_NAME)
    return token !== undefined && this.sessions.has(token)
  }

  private proxyHttp(request: IncomingMessage, response: ServerResponse, clientIp: string): void {
    const upstream = requestHttp({
      hostname: '127.0.0.1',
      port: this.webServer.port,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request.headers, clientIp, forwardedProto(request.headers), this.webServer.port),
    } satisfies RequestOptions, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', error => {
      this.ctx.logger.warn(error)
      if (!response.headersSent) sendText(response, 502, 'Harness is not ready.')
      else response.destroy()
    })
    request.on('aborted', () => upstream.destroy())
    request.pipe(upstream)
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.isAuthorized(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect(this.webServer.port, '127.0.0.1')
    this.upstreamSockets.add(upstream)
    upstream.once('close', () => this.upstreamSockets.delete(upstream))
    upstream.once('connect', () => {
      const headers = proxyHeaders(
        request.headers,
        cleanIp(request.socket.remoteAddress),
        forwardedProto(request.headers),
        this.webServer.port,
      )
      let wire = `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}\r\n`
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) wire += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
      }
      upstream.write(`${wire}\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }

  private isBanned(clientIp: string): boolean {
    const attempt = this.failedAttempts.get(clientIp)
    if (attempt === undefined) return false
    if (attempt.banUntil > Date.now()) return true
    if (attempt.banUntil !== 0) this.failedAttempts.delete(clientIp)
    return false
  }

  private recordFailure(clientIp: string): void {
    const attempt = this.failedAttempts.get(clientIp) ?? { count: 0, banUntil: 0 }
    attempt.count += 1
    if (attempt.count >= this.config.maxFailedAttempts) {
      attempt.banUntil = Date.now() + this.config.banDurationMinutes * 60_000
    }
    this.failedAttempts.set(clientIp, attempt)
  }

  private expireBans(): void {
    const now = Date.now()
    for (const [ip, attempt] of this.failedAttempts) {
      if (attempt.banUntil !== 0 && attempt.banUntil <= now) this.failedAttempts.delete(ip)
    }
  }

  private closeTunnelReaders(): void {
    for (const reader of this.tunnelReaders) reader.close()
    this.tunnelReaders = []
  }
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://gateway.invalid').pathname
}

function findWebServer(ctx: Context): WebServerRuntime | undefined {
  const candidate = ctx.get('webServer') ?? ctx.get('httpServer')
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return undefined
  const server = candidate as Partial<WebServerRuntime>
  if (typeof server.host !== 'string' || typeof server.port !== 'number' || typeof server.register !== 'function') {
    throw new Error('DSH Remote Gateway found an incompatible Web profile HTTP server')
  }
  return server as WebServerRuntime
}

async function waitForWebServer(ctx: Context, timeoutMs: number): Promise<WebServerRuntime> {
  const immediate = findWebServer(ctx)
  if (immediate !== undefined) return immediate
  return await new Promise<WebServerRuntime>((resolvePromise, reject) => {
    let settled = false
    let stop = (): void => {}
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error(`DSH Remote Gateway did not find the Web profile HTTP server within ${timeoutMs}ms`))
    }, timeoutMs)
    const finish = (): void => {
      if (settled) return
      const server = findWebServer(ctx)
      if (server === undefined) return
      settled = true
      clearTimeout(timer)
      stop()
      resolvePromise(server)
    }
    stop = ctx.on('internal/service', name => {
      if (name === 'webServer' || name === 'httpServer') finish()
    })
    ctx.effect(() => () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      reject(new Error('DSH Remote Gateway stopped while waiting for the Web profile HTTP server'))
    }, 'dsh-remote-gateway: Web server wait')
    finish()
  })
}

function cleanIp(value: string | undefined): string {
  return (value ?? 'unknown').replace(/^::ffff:/, '')
}

function stripZone(value: string): string {
  return value.split('%', 1)[0] ?? value
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase()
  return normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim())
  }
  return undefined
}

function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`
}

function expiredCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

function forwardedProto(headers: IncomingHttpHeaders): 'http' | 'https' {
  const header = headers['x-forwarded-proto']
  const value = Array.isArray(header) ? header[0] : header
  return value?.split(',', 1)[0]?.trim().toLowerCase() === 'https' ? 'https' : 'http'
}

function proxyHeaders(
  source: IncomingHttpHeaders,
  clientIp: string,
  proto: 'http' | 'https',
  upstreamPort: number,
): IncomingHttpHeaders {
  const headers = { ...source }
  delete headers.authorization
  const upstreamAuthority = `127.0.0.1:${upstreamPort}`
  headers.host = upstreamAuthority
  if (headers.origin !== undefined) headers.origin = `http://${upstreamAuthority}`
  headers['x-forwarded-for'] = clientIp
  headers['x-forwarded-proto'] = proto
  return headers
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function requireMethod(request: IncomingMessage, response: ServerResponse, method: 'GET' | 'POST'): boolean {
  if (request.method === method) return true
  response.writeHead(405, { allow: method, 'content-type': 'text/plain; charset=utf-8' })
  response.end('Method not allowed.')
  return false
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function sendText(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(value)
}

function sendLoginPage(response: ServerResponse, error = '', status = 200): void {
  const errorMarkup = error === '' ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>DSH Remote Gateway</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f5f5f3;color:#171717}.shell{width:min(100%,420px)}.brand{display:flex;align-items:center;gap:10px;margin:0 0 18px;font-weight:650;font-size:15px}.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:11px;background:#171717;color:#fff}.card{padding:28px;border:1px solid #deded9;border-radius:22px;background:#fff;box-shadow:0 18px 55px rgba(0,0,0,.08)}h1{font-size:25px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}p{margin:0;color:#6a6a66;font-size:14px;line-height:1.55}.zh{margin-top:3px}.fields{display:grid;gap:14px;margin-top:24px}label{display:grid;gap:7px;font-size:12px;font-weight:600;color:#555550}input{width:100%;height:46px;padding:0 13px;border:1px solid #d5d5d0;border-radius:12px;background:#fafaf8;color:inherit;font:inherit;font-size:15px;outline:none}input:focus{border-color:#171717;box-shadow:0 0 0 3px rgba(23,23,23,.1)}button{height:46px;margin-top:18px;width:100%;border:0;border-radius:999px;background:#171717;color:#fff;font:inherit;font-weight:650;cursor:pointer}.error{margin-top:16px;padding:10px 12px;border-radius:10px;background:#fff1f0;color:#b42318;font-size:13px}.foot{margin-top:16px;text-align:center;font-size:12px}@media(prefers-color-scheme:dark){body{background:#171816;color:#f5f5f2}.mark,button{background:#f2f2ed;color:#171717}.card{background:#222320;border-color:#383936;box-shadow:0 18px 55px rgba(0,0,0,.3)}p,.foot{color:#aaa9a2}label{color:#c2c1bb}input{background:#1b1c1a;border-color:#444540}.error{background:#3a201f;color:#ffb4ac}}</style></head><body><main class="shell"><div class="brand"><span class="mark">DS</span><span>DSH Remote Gateway</span></div><section class="card"><h1>Remote access</h1><p>Sign in to control DeepSeek Harness from this browser.</p><p class="zh">登录后即可从当前浏览器远程控制 DeepSeek Harness。</p>${errorMarkup}<form method="post" action="${LOGIN_PATH}"><div class="fields"><label>Username / 用户名<input name="username" autocomplete="username" required autofocus></label><label>Password / 密码<input name="password" type="password" autocomplete="current-password" required></label></div><button type="submit">Continue / 继续</button></form></section><p class="foot">Authenticated HTTPS access powered by Cloudflare Quick Tunnels.</p></main></body></html>`
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  })
  response.end(html)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isQuickTunnelAllocationRejected(error: unknown): boolean {
  return /429 Too Many Requests|error code:\s*1015|failed to unmarshal quick tunnel: invalid character/i.test(message(error))
}

function describeQuickTunnelAllocationFailure(error: unknown): Error {
  const detail = message(error)
  if (/429 Too Many Requests|error code:\s*1015/i.test(detail)) {
    return new Error(`Cloudflare temporarily rate-limited Quick Tunnel creation: ${detail}`, { cause: error })
  }
  if (/failed to unmarshal quick tunnel: invalid character/i.test(detail)) {
    return new Error(`Cloudflare rejected Quick Tunnel creation with a non-JSON response; temporary rate limiting is likely: ${detail}`, { cause: error })
  }
  return error instanceof Error ? error : new Error(detail)
}

async function probePublicGateway(url: string, signal: AbortSignal): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const request = requestHttps(url, { family: 4, method: 'GET', signal }, response => {
      response.resume()
      resolvePromise(response.statusCode ?? 0)
    })
    request.once('error', reject)
    request.end()
  })
}

export default RemoteGatewayService
