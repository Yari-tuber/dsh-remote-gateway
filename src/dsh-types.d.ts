/** Compile-time declarations for browser modules supplied by the active DSH Web profile. */
declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { ComponentType } from 'react'

  export interface ClientContext {
    effect(effect: () => (() => void) | void, label?: string): void
    locale: {
      register(namespace: string, dictionaries: object): () => void
      bind(namespace: string): (key: string) => string
    }
    slots: {
      inject(name: string, factory: () => unknown): void
      register(options: object, component: ComponentType<never>): () => void
    }
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
  export type PropsRuntime<_Name extends string> = {
    close(): void
    renderSlot: (...args: unknown[]) => unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentProps, ComponentType, ReactNode } from 'react'

  type ButtonProps = ComponentProps<'button'> & {
    variant?: 'outline' | 'ghost' | 'primary'
    size?: 'sm'
    icon?: ReactNode
  }
  type IconProps = { size?: number }

  export const Button: ComponentType<ButtonProps>
  export const Input: ComponentType<ComponentProps<'input'>>
  export const IconCopyOutline16: ComponentType<IconProps>
  export const IconGlobeOutline14: ComponentType<IconProps>
  export const IconPlayOutline16: ComponentType<IconProps>
  export const IconRefreshOutline14: ComponentType<IconProps>
  export const IconStopFill16: ComponentType<IconProps>
}
