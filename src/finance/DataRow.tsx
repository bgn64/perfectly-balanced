import type { ComponentPropsWithRef } from 'react'

export function DataRow({
  className,
  ...props
}: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={`data-row${className ? ` ${className}` : ''}`}
      {...props}
    />
  )
}