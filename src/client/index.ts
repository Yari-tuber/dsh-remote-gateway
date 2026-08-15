/** Browser registration for the DSH Remote Gateway settings page. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RemoteGatewaySection } from './RemoteGatewaySection.tsx'
import type { RemoteGatewaySectionInjected } from './RemoteGatewaySection.tsx'
import { en, zh, type RemoteGatewayKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DSH Remote Gateway settings copy. */
    'settings.remote-gateway': RemoteGatewayKey
  }
}

const NAMESPACE = 'settings.remote-gateway'

/** Required Client services. */
export const inject = ['slots', 'locale']

/** Register the bilingual remote gateway settings page. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-remote-gateway: copy dictionaries')
  const t = ctx.locale.bind(NAMESPACE) as RemoteGatewaySectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-gateway',
    order: 35,
    label: () => t('nav'),
    inject: () => ({ t }),
  }, RemoteGatewaySection))
}
