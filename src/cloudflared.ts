/** Managed cloudflared discovery, download verification, and atomic installation. */
import { createHash, randomBytes } from 'node:crypto'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { x as extractTar } from 'tar'

/** Pinned Cloudflare release used by the managed installer. */
export const CLOUDFLARED_VERSION = '2026.8.2'

/** One pinned official Cloudflare release artifact. */
export interface CloudflaredReleaseAsset {
  asset: string
  digest: string
  size: number
  archive: 'binary' | 'tgz'
  compatibility?: 'x64-emulation'
}

const RELEASE_ASSETS: Readonly<Record<string, CloudflaredReleaseAsset>> = {
  'win32-x64': {
    asset: 'cloudflared-windows-amd64.exe',
    digest: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
    size: 54_893_480,
    archive: 'binary',
  },
  'win32-arm64': {
    asset: 'cloudflared-windows-amd64.exe',
    digest: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
    size: 54_893_480,
    archive: 'binary',
    compatibility: 'x64-emulation',
  },
  'linux-x64': {
    asset: 'cloudflared-linux-amd64',
    digest: 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2',
    size: 39_799_316,
    archive: 'binary',
  },
  'linux-arm64': {
    asset: 'cloudflared-linux-arm64',
    digest: '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790',
    size: 37_404_344,
    archive: 'binary',
  },
  'darwin-x64': {
    asset: 'cloudflared-darwin-amd64.tgz',
    digest: 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4',
    size: 21_116_242,
    archive: 'tgz',
  },
  'darwin-arm64': {
    asset: 'cloudflared-darwin-arm64.tgz',
    digest: '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442',
    size: 19_214_189,
    archive: 'tgz',
  },
}

/** cloudflared environment state returned to the settings page. */
export interface CloudflaredEnvironmentStatus {
  state: 'ready' | 'missing' | 'installing' | 'error'
  source?: 'configured' | 'managed' | 'system'
  version?: string
  error?: string
  platform: NodeJS.Platform
  architecture: string
  managedSupported: boolean
  compatibility?: 'native' | 'x64-emulation'
}

export interface CloudflaredManagerOptions {
  configuredPath: string
  dataDirectory?: string
  platform?: NodeJS.Platform
  architecture?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  /** Test or private-mirror override; production callers use the pinned platform map. */
  releaseAsset?: CloudflaredReleaseAsset
  resolveExecutable(command: string): Promise<string>
}

/** Select the official release asset for one operating-system/CPU pair. */
export function selectCloudflaredAsset(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): CloudflaredReleaseAsset | undefined {
  return RELEASE_ASSETS[`${platform}-${architecture}`]
}

/** Resolve the plugin-owned storage root without exposing a machine path to clients. */
export function defaultGatewayDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  const dshHome = configured === undefined || configured.length === 0 ? join(homedir(), '.dsh') : configured
  return resolve(dshHome, 'tools', 'dsh-remote-gateway')
}

/** Detect and install a verified cloudflared executable. */
export class CloudflaredManager {
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly dataDirectory: string
  private readonly env: NodeJS.ProcessEnv
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly asset: CloudflaredReleaseAsset | undefined
  private current: CloudflaredEnvironmentStatus
  private executable: string | undefined
  private installation: Promise<string> | undefined

  constructor(private readonly options: CloudflaredManagerOptions) {
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.env = options.env ?? process.env
    this.dataDirectory = resolve(options.dataDirectory ?? defaultGatewayDataDirectory(this.env))
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.asset = options.releaseAsset ?? selectCloudflaredAsset(this.platform, this.architecture)
    this.current = this.baseStatus('missing')
  }

  /** Return the last completed environment probe or installation state. */
  getStatus(): CloudflaredEnvironmentStatus {
    return { ...this.current }
  }

  /** Discover a configured, system, or already-managed executable. */
  async probe(): Promise<CloudflaredEnvironmentStatus> {
    if (this.installation !== undefined) return this.getStatus()
    const configured = this.options.configuredPath.trim()
    if (configured !== '' && configured !== 'cloudflared') {
      try {
        this.executable = await this.options.resolveExecutable(configured)
        this.current = { ...this.baseStatus('ready'), source: 'configured' }
      } catch (error) {
        this.executable = undefined
        this.current = { ...this.baseStatus('error'), error: `Configured cloudflared was not found: ${message(error)}` }
      }
      return this.getStatus()
    }

    for (const candidate of this.systemCandidates()) {
      try {
        this.executable = await this.options.resolveExecutable(candidate)
        this.current = { ...this.baseStatus('ready'), source: 'system' }
        return this.getStatus()
      } catch {
        // Continue through known system locations before checking managed storage.
      }
    }

    const managed = this.managedExecutablePath()
    if (managed !== undefined && await this.managedInstallMatches(managed)) {
      this.executable = await this.options.resolveExecutable(managed)
      this.current = { ...this.baseStatus('ready'), source: 'managed', version: CLOUDFLARED_VERSION }
      return this.getStatus()
    }

    this.executable = undefined
    this.current = this.baseStatus('missing')
    return this.getStatus()
  }

  /** Return a usable executable, installing the pinned official build when needed. */
  async ensureInstalled(): Promise<string> {
    const status = await this.probe()
    if (status.state === 'ready' && this.executable !== undefined) return this.executable
    if (this.options.configuredPath.trim() !== '' && this.options.configuredPath.trim() !== 'cloudflared') {
      throw new Error(status.error ?? 'Configured cloudflared is unavailable')
    }
    if (this.installation !== undefined) return this.installation
    const operation = this.installManaged()
    this.installation = operation
    try {
      return await operation
    } finally {
      if (this.installation === operation) this.installation = undefined
    }
  }

  /** Return the executable selected by the last successful probe or install. */
  getExecutable(): string | undefined {
    return this.executable
  }

  private async installManaged(): Promise<string> {
    if (this.asset === undefined) {
      const error = `Managed cloudflared installation is not available for ${this.platform}/${this.architecture}`
      this.current = { ...this.baseStatus('error'), error }
      throw new Error(error)
    }
    this.current = this.baseStatus('installing')
    const cloudflaredRoot = join(this.dataDirectory, 'cloudflared')
    const finalDirectory = join(cloudflaredRoot, CLOUDFLARED_VERSION)
    await mkdir(finalDirectory, { recursive: true, mode: 0o700 })
    const temporaryDirectory = await mkdtemp(join(cloudflaredRoot, '.install-'))
    try {
      const downloaded = join(temporaryDirectory, this.asset.asset)
      await downloadVerified(this.fetchImpl, releaseUrl(this.asset.asset), downloaded, this.asset)
      const sourceExecutable = this.asset.archive === 'binary'
        ? downloaded
        : await extractCloudflared(downloaded, temporaryDirectory)
      await chmod(sourceExecutable, 0o755)

      const finalExecutable = join(finalDirectory, executableName(this.platform))
      const stagedExecutable = join(finalDirectory, `.${executableName(this.platform)}.${randomBytes(6).toString('hex')}.tmp`)
      await copyFile(sourceExecutable, stagedExecutable, fsConstants.COPYFILE_EXCL)
      await chmod(stagedExecutable, 0o755)
      const handle = await open(stagedExecutable, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await unlink(finalExecutable).catch(ignoreMissing)
      await rename(stagedExecutable, finalExecutable)
      const executableDigest = await fileDigest(finalExecutable)
      const manifest = join(finalDirectory, 'install.json')
      const stagedManifest = join(finalDirectory, `.install.${randomBytes(6).toString('hex')}.tmp`)
      const manifestHandle = await open(stagedManifest, 'wx', 0o600)
      try {
        await manifestHandle.writeFile(`${JSON.stringify({
          version: CLOUDFLARED_VERSION,
          asset: this.asset.asset,
          assetDigest: this.asset.digest,
          executableDigest,
        }, null, 2)}\n`)
        await manifestHandle.sync()
      } finally {
        await manifestHandle.close()
      }
      await unlink(manifest).catch(ignoreMissing)
      await rename(stagedManifest, manifest)
      this.executable = await this.options.resolveExecutable(finalExecutable)
      this.current = { ...this.baseStatus('ready'), source: 'managed', version: CLOUDFLARED_VERSION }
      return this.executable
    } catch (error) {
      this.executable = undefined
      this.current = { ...this.baseStatus('error'), error: `cloudflared installation failed: ${message(error)}` }
      throw new Error(this.current.error, { cause: error })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  private managedExecutablePath(): string | undefined {
    return this.asset === undefined
      ? undefined
      : join(this.dataDirectory, 'cloudflared', CLOUDFLARED_VERSION, executableName(this.platform))
  }

  private async managedInstallMatches(executable: string): Promise<boolean> {
    if (this.asset === undefined) return false
    try {
      const record = JSON.parse(await readFile(join(dirname(executable), 'install.json'), 'utf8')) as {
        version?: unknown
        asset?: unknown
        assetDigest?: unknown
        executableDigest?: unknown
      }
      return record.version === CLOUDFLARED_VERSION
        && record.asset === this.asset.asset
        && record.assetDigest === this.asset.digest
        && typeof record.executableDigest === 'string'
        && await fileMatches(executable, record.executableDigest)
    } catch {
      return false
    }
  }

  private systemCandidates(): string[] {
    const candidates = ['cloudflared']
    if (this.platform !== 'win32') return candidates
    for (const root of [this.env['ProgramFiles(x86)'], this.env.ProgramFiles]) {
      if (root !== undefined && root.trim() !== '') candidates.push(join(root, 'cloudflared', 'cloudflared.exe'))
    }
    return candidates
  }

  private baseStatus(state: CloudflaredEnvironmentStatus['state']): CloudflaredEnvironmentStatus {
    return {
      state,
      platform: this.platform,
      architecture: this.architecture,
      managedSupported: this.asset !== undefined,
      compatibility: this.asset?.compatibility ?? 'native',
    }
  }
}

function releaseUrl(asset: string): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`
}

function executableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

async function downloadVerified(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  filename: string,
  asset: CloudflaredReleaseAsset,
): Promise<void> {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'dsh-remote-gateway' },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`download returned HTTP ${response.status}`)
  if (response.url !== '') {
    const hostname = new URL(response.url).hostname.toLowerCase()
    if (hostname !== 'github.com' && !hostname.endsWith('.githubusercontent.com')) {
      throw new Error(`download redirected to an untrusted host: ${hostname}`)
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== asset.size) {
    throw new Error(`download size mismatch: expected ${asset.size}, received ${bytes.byteLength}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== asset.digest) throw new Error(`SHA-256 mismatch for ${asset.asset}`)
  const file = await open(filename, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function extractCloudflared(archive: string, destination: string): Promise<string> {
  let extracted = false
  await extractTar({
    file: archive,
    cwd: destination,
    strict: true,
    filter(path) {
      const accepted = basename(path) === 'cloudflared'
      if (accepted) extracted = true
      return accepted
    },
  })
  const executable = join(destination, 'cloudflared')
  if (!extracted) throw new Error('archive does not contain a regular cloudflared file')
  const stats = await lstat(executable)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('archive cloudflared entry is not a regular file')
  await access(executable, fsConstants.R_OK)
  return executable
}

async function fileMatches(filename: string, expectedDigest: string): Promise<boolean> {
  try {
    return await fileDigest(filename) === expectedDigest
  } catch {
    return false
  }
}

async function fileDigest(filename: string): Promise<string> {
  const bytes = await readFile(filename)
  return createHash('sha256').update(bytes).digest('hex')
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
