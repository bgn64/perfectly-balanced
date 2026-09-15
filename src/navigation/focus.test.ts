import { afterEach, describe, expect, it, vi } from 'vitest'
import { trapTabFocus } from './focus.ts'

afterEach(() => vi.unstubAllGlobals())

describe('dialog Tab containment', () => {
  function fixture() {
    const controls = Array.from({ length: 2 }, () => ({
      tabIndex: 0, matches: (): boolean => false, closest: () => null,
      getClientRects: () => [{}], focus: vi.fn(),
    }))
    const container = { querySelectorAll: () => controls, focus: vi.fn() }
    return { controls, container: container as unknown as HTMLElement }
  }

  it('wraps forward and backward at the boundaries', () => {
    const { controls, container } = fixture()
    const preventDefault = vi.fn()
    vi.stubGlobal('document', { activeElement: controls[1] })
    trapTabFocus({ key: 'Tab', shiftKey: false, preventDefault }, container)
    expect(controls[0].focus).toHaveBeenCalledOnce()
    vi.stubGlobal('document', { activeElement: controls[0] })
    trapTabFocus({ key: 'Tab', shiftKey: true, preventDefault }, container)
    expect(controls[1].focus).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it('keeps normal interior Tab and non-Tab keys native', () => {
    const { controls, container } = fixture()
    vi.stubGlobal('document', { activeElement: controls[0] })
    const preventDefault = vi.fn()
    trapTabFocus({ key: 'Tab', shiftKey: false, preventDefault }, container)
    trapTabFocus({ key: 'Enter', shiftKey: false, preventDefault }, container)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('focuses the container when no eligible controls remain', () => {
    const { controls, container } = fixture()
    controls.forEach(control => { control.tabIndex = -1 })
    vi.stubGlobal('document', { activeElement: null })
    trapTabFocus({ key: 'Tab', shiftKey: false, preventDefault: vi.fn() }, container)
    expect(container.focus).toHaveBeenCalledOnce()
  })

  it('skips disabled controls when entering the dialog', () => {
    const { controls, container } = fixture()
    controls[0].matches = () => true
    vi.stubGlobal('document', { activeElement: null })
    trapTabFocus({ key: 'Tab', shiftKey: false, preventDefault: vi.fn() }, container)
    expect(controls[0].focus).not.toHaveBeenCalled()
    expect(controls[1].focus).toHaveBeenCalledOnce()
  })
})