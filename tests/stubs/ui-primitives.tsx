import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

export function Button({ icon, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; variant?: string; size?: string }) {
  return <button {...props}>{icon}{children}</button>
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />
}

export const IconCopyOutline16 = () => <span aria-hidden="true" />
export const IconGlobeOutline14 = () => <span aria-hidden="true" />
export const IconPlayOutline16 = () => <span aria-hidden="true" />
export const IconRefreshOutline14 = () => <span aria-hidden="true" />
export const IconStopFill16 = () => <span aria-hidden="true" />
