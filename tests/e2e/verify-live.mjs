import { randomBytes } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

const coreOrigin = required('DSH_REMOTE_GATEWAY_CORE_ORIGIN')
const gatewayOrigin = required('DSH_REMOTE_GATEWAY_LOCAL_ORIGIN')
const username = required('DSH_REMOTE_GATEWAY_USERNAME')
const password = required('DSH_REMOTE_GATEWAY_PASSWORD')
const skipTunnel = process.env.DSH_REMOTE_GATEWAY_SKIP_TUNNEL === '1'

const report = {}
let tunnelStarted = false
try {
  const coreStatus = await requestJson(`${coreOrigin}/api/remote-gateway/status`)
  assert(coreStatus.environment?.state === 'ready' || coreStatus.environment?.managedSupported === true,
    'cloudflared is missing and managed installation is unavailable')
  report.initialEnvironment = `${coreStatus.environment.source ?? 'none'}:${coreStatus.environment.state}`

  const localCookie = await login(gatewayOrigin, username, password)
  const localApi = await fetch(`${gatewayOrigin}/api/remote-gateway/status`, { headers: { cookie: localCookie } })
  assert(localApi.status === 200, `local gateway API returned ${localApi.status}`)
  report.localLogin = 303
  report.localApi = localApi.status

  for (const path of ['/api/events.mux', '/api/events.host']) {
    await websocketUpgrade(gatewayOrigin, path, localCookie)
    report[`localWebsocket:${path}`] = 101
  }

  if (!skipTunnel) {
    const started = await requestJson(`${coreOrigin}/api/remote-gateway/tunnel/start`, { method: 'POST' })
    assert(started.data?.environment?.state === 'ready', 'one-click setup did not prepare cloudflared')
    report.environment = `${started.data.environment.source}:${started.data.environment.state}`
    const publicOrigin = started.data?.tunnel?.publicUrl
    assert(typeof publicOrigin === 'string', 'tunnel start did not return a public URL')
    tunnelStarted = true

    const publicCookie = await retry(() => login(publicOrigin, username, password), 30, 1_500)
    const publicApi = await retry(async () => {
      const response = await fetch(`${publicOrigin}/api/remote-gateway/status`, { headers: { cookie: publicCookie } })
      if (response.status !== 200) throw new Error(`public API returned ${response.status}`)
      return response
    }, 8, 750)
    report.publicLogin = 303
    report.publicApi = publicApi.status

    for (const path of ['/api/events.mux', '/api/events.host']) {
      await websocketUpgrade(publicOrigin, path, publicCookie)
      report[`publicWebsocket:${path}`] = 101
    }
  }
} finally {
  if (tunnelStarted) {
    const stopped = await requestJson(`${coreOrigin}/api/remote-gateway/tunnel/stop`, { method: 'POST' })
    report.tunnel = stopped.data?.tunnel?.state
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

async function login(origin, loginUsername, loginPassword) {
  const response = await fetch(`${origin}/__dsh_remote_gateway/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: loginUsername, password: loginPassword }),
  })
  if (response.status !== 303) throw new Error(`login returned ${response.status}`)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('login did not return a session cookie')
  return cookie
}

async function websocketUpgrade(origin, path, cookie) {
  const url = new URL(origin)
  const secure = url.protocol === 'https:'
  const port = Number(url.port || (secure ? 443 : 80))
  const socket = secure
    ? tls.connect({ host: url.hostname, port, servername: url.hostname })
    : net.connect({ host: url.hostname, port })
  const response = await new Promise((resolve, reject) => {
    let received = ''
    const timeout = setTimeout(() => reject(new Error(`WebSocket ${path} timed out`)), 15_000)
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => {
      received += chunk
      if (!received.includes('\r\n\r\n')) return
      clearTimeout(timeout)
      resolve(received)
      socket.destroy()
    })
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        `Origin: ${url.origin}`,
        `Cookie: ${cookie}`,
        '',
        '',
      ].join('\r\n'))
    })
  })
  const statusLine = response.split('\r\n', 1)[0]
  assert(response.startsWith('HTTP/1.1 101'), `WebSocket ${path} did not open: ${statusLine}`)
}

async function requestJson(url, init) {
  const response = await fetch(url, init)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function retry(operation, attempts, delayMs) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

function required(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
