function scrollableAncestor(element: HTMLElement): HTMLElement | null {
  let candidate = element.parentElement
  while (candidate) {
    const overflowY = window.getComputedStyle(candidate).overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      candidate.scrollHeight > candidate.clientHeight
    ) {
      return candidate
    }
    candidate = candidate.parentElement
  }
  return null
}

export function scrollIntoComfortView(element: HTMLElement) {
  const anchor =
    element.closest<HTMLElement>(
      '.pending-budget-entry, .budget-row, .budget-subsection-head, .transaction-row-simple',
    ) ?? element
  const container = scrollableAncestor(anchor)
  if (!container) {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return
  }

  const containerRect = container.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const expandedListbox = anchor.querySelector<HTMLElement>(
    '[role="listbox"]',
  )
  const listboxRect = expandedListbox?.getClientRects().length
    ? expandedListbox.getBoundingClientRect()
    : null
  const targetTop = Math.min(anchorRect.top, listboxRect?.top ?? anchorRect.top)
  const targetBottom = Math.max(
    anchorRect.bottom,
    listboxRect?.bottom ?? anchorRect.bottom,
  )
  const topComfort = Math.min(128, containerRect.height * 0.22)
  const bottomComfort = Math.min(160, containerRect.height * 0.25)
  let scrollDelta = 0

  if (targetTop < containerRect.top + topComfort) {
    scrollDelta = targetTop - (containerRect.top + topComfort)
  } else if (targetBottom > containerRect.bottom - bottomComfort) {
    scrollDelta = targetBottom - (containerRect.bottom - bottomComfort)
  }

  if (scrollDelta !== 0) {
    container.scrollBy({ top: scrollDelta })
  }
}

export function focusWithScrollComfort(element: HTMLElement) {
  element.focus({ preventScroll: true })
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => scrollIntoComfortView(element))
  })
}