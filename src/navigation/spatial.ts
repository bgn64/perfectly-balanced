export type SpatialDirection = 'up' | 'down' | 'left' | 'right'

interface PositionedControl {
  control: HTMLElement
  index: number
  rect: DOMRect
}

const alignmentTolerance = 4

function center(start: number, end: number): number {
  return start + (end - start) / 2
}

function overlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): number {
  return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart))
}

function compareScores(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

export function findSpatialTarget(
  current: HTMLElement,
  controls: HTMLElement[],
  direction: SpatialDirection,
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect()
  const currentCenterX = center(currentRect.left, currentRect.right)
  const currentCenterY = center(currentRect.top, currentRect.bottom)
  const horizontal = direction === 'left' || direction === 'right'
  const forwardSign = direction === 'left' || direction === 'up' ? -1 : 1

  const candidates = controls
    .map<PositionedControl>((control, index) => ({
      control,
      index,
      rect: control.getBoundingClientRect(),
    }))
    .filter(({ control, rect }) => {
      if (control === current || rect.width === 0 || rect.height === 0) {
        return false
      }
      if (
        horizontal &&
        overlap(currentRect.top, currentRect.bottom, rect.top, rect.bottom) === 0
      ) {
        return false
      }
      const candidateCenter = horizontal
        ? center(rect.left, rect.right)
        : center(rect.top, rect.bottom)
      const currentCenter = horizontal ? currentCenterX : currentCenterY
      return (candidateCenter - currentCenter) * forwardSign > alignmentTolerance
    })
    .map(({ control, index, rect }) => {
      const candidateCenterX = center(rect.left, rect.right)
      const candidateCenterY = center(rect.top, rect.bottom)
      const perpendicularOverlap = horizontal
        ? overlap(currentRect.top, currentRect.bottom, rect.top, rect.bottom)
        : overlap(currentRect.left, currentRect.right, rect.left, rect.right)
      const primaryDistance = horizontal
        ? Math.abs(candidateCenterX - currentCenterX)
        : Math.abs(candidateCenterY - currentCenterY)
      const perpendicularDistance = horizontal
        ? Math.abs(candidateCenterY - currentCenterY)
        : Math.abs(candidateCenterX - currentCenterX)
      return {
        control,
        score: [
          perpendicularOverlap > 0 ? 0 : 1,
          primaryDistance,
          perpendicularDistance,
          index,
        ],
      }
    })
    .sort((left, right) => compareScores(left.score, right.score))

  return candidates[0]?.control ?? null
}