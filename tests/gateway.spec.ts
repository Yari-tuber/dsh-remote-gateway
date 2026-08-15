import { createServer } from 'node:http'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import RemoteGatewayService from '../src/index.ts'

class FakeSubprocessRuntime extends SubprocessRuntime {
  spawnCount = 0
  quickTunnelFailure: string | undefined

  async resolveExecutable(command: string): Promise<string> {
    return `C:/fake/${command.replaceAll('\\', '-')}.exe`
  }

  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawnCount += 1
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let finish!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
    let stopped = false
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => { finish = resolve })
    queueMicrotask(() => {
      if (this.quickTunnelFailure !== undefined) {
        stderr.end(`${this.quickTunnelFailure}\n`)
        stdout.end()
        finish({ exitCode: 1, signal: null })
        return
      }
      stderr.write('INF https://calm-river.trycloudflare.com ready\nINF Registered tunnel connection\n')
    })
    return {
      pid: 42,
      stdin: undefined,
      stdout,
      stderr,
      collected: {},
      done,
      terminate: () => {
        if (stopped) return
        stopped = true
        stdout.end()
        stderr.end()
        finish({ exitCode: 0, signal: null })
      },
      waitForExit: async () => true,
    }
  }

  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('not used')
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('RemoteGatewayService', () => {
  it('authenticates and proxies HTTP, WebSocket, and a Quick Tunnel through a real gateway', async () => {
    const gatewayPort = await freePort()
    const ctx = await createContext(gatewayPort)
    const disposeFallback = ctx.httpServer.registerFallback((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('CORE_OK')
    })
    const disposeHeaders = ctx.httpServer.register({
      kind: 'exact',
      path: '/headers',
      handler: (request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin }))
      },
    })
    let upgradeHeaders: { host: string | undefined; origin: string | undefined } = { host: undefined, origin: undefined }
    const disposeUpgrade = ctx.httpServer.registerUpgrade({
      path: '/socket',
      handler: (request, socket) => {
        upgradeHeaders = { host: request.headers.host, origin: request.headers.origin }
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      },
    })

    const origin = `http://127.0.0.1:${gatewayPort}`
    const denied = await fetch(origin, { redirect: 'manual' })
    expect(denied.status).toBe(303)

    const loginPage = await fetch(`${origin}/__dsh_remote_gateway/login`)
    expect(await loginPage.text()).toContain('DSH Remote Gateway')
    const login = await fetch(`${origin}/__dsh_remote_gateway/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'phone', password: 'correct-horse' }),
    })
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    expect(login.status).toBe(303)
    expect(cookie).toMatch(/^dsh_remote_gateway_session=/)

    const proxied = await fetch(origin, { headers: { cookie: cookie! } })
    expect(await proxied.text()).toBe('CORE_OK')
    const normalized = await fetch(`${origin}/headers`, {
      headers: { cookie: cookie!, origin: 'https://phone.example' },
    })
    expect(await normalized.json()).toEqual({
      host: `127.0.0.1:${ctx.httpServer.port}`,
      origin: `http://127.0.0.1:${ctx.httpServer.port}`,
    })
    expect(await rawUpgrade(gatewayPort, cookie!)).toContain('101 Switching Protocols')
    expect(upgradeHeaders).toEqual({
      host: `127.0.0.1:${ctx.httpServer.port}`,
      origin: `http://127.0.0.1:${ctx.httpServer.port}`,
    })

    const tunnel = await ctx.remoteGateway.startQuickTunnel()
    expect(tunnel.environment).toMatchObject({ state: 'ready', source: 'system' })
    expect(tunnel.tunnel).toMatchObject({ state: 'running', publicUrl: 'https://calm-river.trycloudflare.com' })
    await ctx.remoteGateway.stopQuickTunnel()

    disposeUpgrade()
    disposeHeaders()
    disposeFallback()
  })

  it('validates live settings before publishing them', async () => {
    const gatewayPort = await freePort()
    const ctx = await createContext(gatewayPort)
    await expect(ctx.remoteGateway.update({ port: 70_000 })).rejects.toThrow(/1 through 65535/)
    expect(ctx.remoteGateway.getStatus().port).toBe(gatewayPort)
    const next = await ctx.remoteGateway.update({ username: 'mobile', password: 'replacement-pass' })
    expect(next).toMatchObject({ username: 'mobile', password: 'replacement-pass', running: true })
  })

  it('replaces a registered Quick Tunnel when its public login page is unreachable', async () => {
    const gatewayPort = await freePort()
    const ctx = await createContext(gatewayPort)
    const subprocess = ctx.subprocess as FakeSubprocessRuntime
    ctx.remoteGateway.internals.probePublicGateway = async () => subprocess.spawnCount === 1 ? 503 : 200

    const status = await ctx.remoteGateway.startQuickTunnel()

    expect(subprocess.spawnCount).toBe(2)
    expect(status.tunnel.state).toBe('running')
  })

  it('does not amplify a Cloudflare Quick Tunnel rate limit', async () => {
    const gatewayPort = await freePort()
    const ctx = await createContext(gatewayPort)
    const subprocess = ctx.subprocess as FakeSubprocessRuntime
    subprocess.quickTunnelFailure = 'ERR Error unmarshaling QuickTunnel response: error code: 1015 status_code="429 Too Many Requests"'

    await expect(ctx.remoteGateway.startQuickTunnel()).rejects.toThrow(/429 Too Many Requests/)

    expect(subprocess.spawnCount).toBe(1)
  })

  it('does not retry a non-JSON Cloudflare Quick Tunnel rejection', async () => {
    const gatewayPort = await freePort()
    const ctx = await createContext(gatewayPort)
    const subprocess = ctx.subprocess as FakeSubprocessRuntime
    subprocess.quickTunnelFailure = "ERR failed to unmarshal quick Tunnel: invalid character 'e' looking for beginning of value"

    await expect(ctx.remoteGateway.startQuickTunnel()).rejects.toThrow(/temporary rate limiting is likely/)

    expect(subprocess.spawnCount).toBe(1)
  })
})

async function createContext(gatewayPort: number): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(FakeSubprocessRuntime)
  await ctx.plugin(RemoteGatewayService, {
    enabled: true,
    listenHost: '127.0.0.1',
    port: gatewayPort,
    username: 'phone',
    password: 'correct-horse',
    maxFailedAttempts: 3,
    banDurationMinutes: 1,
    cloudflaredPath: 'cloudflared',
    autoInstallCloudflared: true,
    autoStartQuickTunnel: false,
    tunnelProtocol: 'http2',
    dataDirectory: '',
    tunnelStartupTimeoutMs: 2_000,
    tunnelStartupAttempts: 3,
    tunnelReachabilityTimeoutMs: 100,
    processGraceMs: 100,
    webServerStartupTimeoutMs: 2_000,
  })
  ctx.remoteGateway.internals.probePublicGateway = async () => 200
  return ctx
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test port was not assigned')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function rawUpgrade(port: number, cookie: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => { response += chunk })
    socket.once('close', () => resolve(response))
    socket.once('connect', () => {
      socket.write([
        'GET /socket HTTP/1.1',
        'Host: remote.test',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGVzdC1rZXk=',
        'Origin: https://phone.example',
        `Cookie: ${cookie}`,
        '',
        '',
      ].join('\r\n'))
    })
  })
}
