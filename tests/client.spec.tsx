/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteGatewaySection } from '../src/client/RemoteGatewaySection.tsx'
import type { RemoteGatewayStatus } from '../src/client/RemoteGatewaySection.tsx'
import { zh } from '../src/client/locales.ts'

const baseStatus: RemoteGatewayStatus = {
  enabled: true,
  running: true,
  listenHost: '::',
  port: 3088,
  username: 'admin',
  password: 'mobile-password',
  coreHost: '127.0.0.1',
  corePort: 3080,
  coreLoopback: true,
  activeConnections: 1,
  addresses: [{
    family: 'IPv4',
    address: '192.0.2.10',
    scope: 'lan',
    interfaceName: 'Wi-Fi',
    url: 'http://192.0.2.10:3088',
  }],
  environment: {
    state: 'missing',
    platform: 'win32',
    architecture: 'x64',
    managedSupported: true,
    compatibility: 'native',
  },
  tunnel: { state: 'stopped' },
}

describe('RemoteGatewaySection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('shows one-click setup, adopts the public URL, copies it, and marks the mobile dialog', async () => {
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === '/api/remote-gateway/status') return jsonResponse(baseStatus)
      if (url === '/api/remote-gateway/tunnel/start') {
        return jsonResponse({
          success: true,
          data: {
            ...baseStatus,
            environment: { ...baseStatus.environment, state: 'ready', source: 'managed', version: '2026.8.2' },
            tunnel: { state: 'running', publicUrl: 'https://calm-river.trycloudflare.com' },
          },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    globalThis.fetch = mockFetch as typeof fetch

    const { container } = render(
      <div role="dialog">
        <RemoteGatewaySection close={() => {}} renderSlot={() => null} t={key => zh[key]} />
      </div>,
    )
    await screen.findByText('http://192.0.2.10:3088')
    expect(container.querySelector('[role="dialog"]')?.getAttribute('data-dsh-remote-gateway-dialog')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '一键配置并启动' }))
    await screen.findByText('https://calm-river.trycloudflare.com')
    fireEvent.click(screen.getAllByRole('button', { name: '复制' })[0]!)
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://calm-river.trycloudflare.com'))
  })

  it('shows the core-listener bypass warning', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ...baseStatus, coreHost: '0.0.0.0', coreLoopback: false })) as typeof fetch
    render(<RemoteGatewaySection close={() => {}} renderSlot={() => null} t={key => zh[key]} />)
    expect((await screen.findByRole('alert')).textContent).toContain('绕过本插件的登录保护')
  })
})

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response
}
