import {
  useEffect,
  useRef,
  type KeyboardEventHandler,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { focusWithScrollComfort } from './focus.ts'
import { findSpatialTarget, type SpatialDirection } from './spatial.ts'

const focusableSelector =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function focusableControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (control) => control.getClientRects().length > 0,
  )
}

export function AppModal({
  ariaLabelledBy,
  children,
  className = '',
  initialFocusSelector,
  layerClassName = '',
  onClose,
  onKeyDown,
  statusLabel,
}: {
  ariaLabelledBy: string
  children: ReactNode
  className?: string
  initialFocusSelector?: string
  layerClassName?: string
  onClose: () => void
  onKeyDown?: KeyboardEventHandler<HTMLElement>
  statusLabel?: string
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const originRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    originRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const animationFrame = window.requestAnimationFrame(() => {
      const target = initialFocusSelector
        ? dialogRef.current?.querySelector<HTMLElement>(initialFocusSelector)
        : null
      const fallback = dialogRef.current?.querySelector<HTMLElement>(
        focusableSelector,
      )
      const focusTarget = target ?? fallback
      if (focusTarget) {
        focusWithScrollComfort(focusTarget)
      }
    })

    return () => {
      window.cancelAnimationFrame(animationFrame)
      const origin = originRef.current
      window.requestAnimationFrame(() => {
        if (origin?.isConnected) {
          focusWithScrollComfort(origin)
        }
      })
    }
  }, [initialFocusSelector])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    const key = event.key.toLocaleLowerCase()
    const spatialDirection: SpatialDirection | null =
      key === 'h'
        ? 'left'
        : key === 'j'
          ? 'down'
          : key === 'k'
            ? 'up'
            : key === 'l'
              ? 'right'
              : null
    const isTextEntry =
      event.target instanceof HTMLElement &&
      event.target.closest(
        'input, textarea, select, [contenteditable="true"]',
      ) !== null
    if (
      spatialDirection &&
      !isTextEntry &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.target instanceof HTMLElement
    ) {
      const spatialRoot =
        event.target.closest<HTMLElement>('[role="listbox"]') ??
        event.currentTarget
      const target = findSpatialTarget(
        event.target,
        focusableControls(spatialRoot),
        spatialDirection,
      )
      if (target) {
        event.preventDefault()
        focusWithScrollComfort(target)
      }
      return
    }
    if (event.key !== 'Tab') {
      return
    }
    const controls = focusableControls(event.currentTarget)
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) {
      event.preventDefault()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const modal = (
    <div className={`app-modal-layer${layerClassName ? ` ${layerClassName}` : ''}`}>
      <section
        aria-labelledby={ariaLabelledBy}
        aria-modal="true"
        className={`app-modal${className ? ` ${className}` : ''}`}
        data-semantic-id={statusLabel ? 'transaction-detail-dialog' : undefined}
        data-semantic-kind={statusLabel ? 'transaction-detail' : undefined}
        data-semantic-region={statusLabel ? 'workspace' : undefined}
        data-status-action={statusLabel ? 'edit transaction' : undefined}
        data-status-label={statusLabel}
        ref={dialogRef}
        role="dialog"
        onKeyDown={handleKeyDown}
      >
        {children}
      </section>
    </div>
  )
  const shell = document.querySelector<HTMLElement>('.authenticated-app')
  return shell ? createPortal(modal, shell) : modal
}