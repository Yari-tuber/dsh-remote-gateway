import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudflaredManager, selectCloudflaredAsset } from '../src/cloudflared.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('CloudflaredManager', () => {
  it('recognizes every supported platform and marks Windows ARM64 emulation', () => {
    expect(selectCloudflaredAsset('win32', 'x64')?.asset).toBe('cloudflared-windows-amd64.exe')
    expect(selectCloudflaredAsset('win32', 'arm64')?.compatibility).toBe('x64-emulation')
    expect(selectCloudflaredAsset('linux', 'x64')?.asset).toBe('cloudflared-linux-amd64')
    expect(selectCloudflaredAsset('linux', 'arm64')?.asset).toBe('cloudflared-linux-arm64')
    expect(selectCloudflaredAsset('darwin', 'x64')?.archive).toBe('tgz')
    expect(selectCloudflaredAsset('darwin', 'arm64')?.archive).toBe('tgz')
    expect(selectCloudflaredAsset('freebsd', 'x64')).toBeUndefined()
  })

  it('uses an existing system executable without downloading anything', async () => {
    const fetch = async () => { throw new Error('download should not run') }
    const manager = new CloudflaredManager({
      configuredPath: 'cloudflared',
      fetch: fetch as typeof globalThis.fetch,
      resolveExecutable: async command => `resolved:${command}`,
    })
    expect(await manager.probe()).toMatchObject({ state: 'ready', source: 'system' })
    expect(await manager.ensureInstalled()).toBe('resolved:cloudflared')
  })

  it('downloads, verifies, atomically installs, and rediscovers a managed executable', async () => {
    const directory = await makeTempDirectory()
    const bytes = Buffer.from('verified cloudflared test executable')
    const asset = {
      asset: 'cloudflared-test',
      digest: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      archive: 'binary' as const,
    }
    const resolveExecutable = async (command: string) => {
      if (command === 'cloudflared') throw new Error('not on PATH')
      await access(command)
      return command
    }
    const options = {
      configuredPath: 'cloudflared',
      dataDirectory: directory,
      platform: 'linux' as const,
      architecture: 'x64',
      releaseAsset: asset,
      fetch: (async () => new Response(bytes, { status: 200 })) as typeof globalThis.fetch,
      resolveExecutable,
    }
    const first = new CloudflaredManager(options)
    const executable = await first.ensureInstalled()
    expect(await readFile(executable)).toEqual(bytes)
    expect(first.getStatus()).toMatchObject({ state: 'ready', source: 'managed', version: '2026.8.2' })

    const second = new CloudflaredManager(options)
    expect(await second.probe()).toMatchObject({ state: 'ready', source: 'managed' })
    expect(second.getExecutable()).toBe(executable)
  })

  it('rejects a download before installation when SHA-256 does not match', async () => {
    const directory = await makeTempDirectory()
    const bytes = Buffer.from('unexpected bytes')
    const manager = new CloudflaredManager({
      configuredPath: 'cloudflared',
      dataDirectory: directory,
      platform: 'linux',
      architecture: 'x64',
      releaseAsset: {
        asset: 'cloudflared-test',
        digest: '0'.repeat(64),
        size: bytes.byteLength,
        archive: 'binary',
      },
      fetch: (async () => new Response(bytes, { status: 200 })) as typeof globalThis.fetch,
      resolveExecutable: async command => {
        if (command === 'cloudflared') throw new Error('not on PATH')
        return command
      },
    })
    await expect(manager.ensureInstalled()).rejects.toThrow(/SHA-256 mismatch/)
    expect(manager.getStatus()).toMatchObject({ state: 'error' })
  })
})

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-gateway-test-'))
  temporaryDirectories.push(directory)
  return directory
}
