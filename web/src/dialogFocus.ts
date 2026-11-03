import { useEffect, useRef } from 'react'

/**
 * Keeps the keyboard inside a dialog while it is open, and gives focus back when it closes.
 *
 * Without this, opening a dialog leaves focus on `body`: Tab walks the page behind the dialog, Enter
 * activates a row nobody can see, and the dialog can only be used with a mouse. That is not a style
 * question, it is whether the surface is usable at all.
 */
export function useDialogFocus<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const previous = document.activeElement as HTMLElement | null
    const focusables = (): HTMLElement[] =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)

    // The first real control takes focus, so the dialog is operable the moment it appears.
    const first = focusables()[0]
    if (first) first.focus()
    else node.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const head = items[0]
      const tail = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey && (active === head || !node.contains(active))) {
        event.preventDefault()
        tail.focus()
      } else if (!event.shiftKey && (active === tail || !node.contains(active))) {
        event.preventDefault()
        head.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [])

  return ref
}
