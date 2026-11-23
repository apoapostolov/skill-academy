import { useEffect, useRef } from 'react'
import { renderMarkdown } from './markdown'

/**
 * One markdown renderer for every surface that shows a skill body or a draft. The markup is parsed
 * into an inert document and moved in as nodes: `renderMarkdown` drops raw HTML from the source and
 * escapes every text run, so the nodes never carry the file's own tags, and a stray script could not
 * run even if one survived. The table and code scrollers draw their own bar.
 */
export function MarkdownBody({ text, className }: { text: string; className: string }) {
  const host = useRef<HTMLDivElement>(null)

  // The markup is parsed into an inert document and moved in as nodes. renderMarkdown drops raw
  // HTML from the source and escapes every text run, so this never carries the file's own tags, and
  // building nodes instead of assigning innerHTML means a stray script tag could not run anyway.
  useEffect(() => {
    const element = host.current
    if (!element) return
    const parsed = new DOMParser().parseFromString(`<div>${renderMarkdown(text)}</div>`, 'text/html')
    const painted = parsed.body.firstElementChild
    element.replaceChildren(...(painted ? [...painted.childNodes] : []))

    const cleanups: Array<() => void> = []

    for (const scroller of element.querySelectorAll<HTMLDivElement>('.md-table, .md-code pre')) {
      // A bar drawn by us rather than by the platform: it overlays the scroller instead of
      // reserving a lane, follows the scroll position, and fades when the reader stops.
      const thumb = document.createElement('span')
      thumb.className = 'md-thumb'
      thumb.setAttribute('aria-hidden', 'true')
      scroller.appendChild(thumb)

      let timer: number | undefined
      const paint = () => {
        const track = scroller.clientWidth
        const total = scroller.scrollWidth
        if (total <= track + 1) {
          thumb.style.width = '0px'
          return
        }
        const width = Math.max(28, (track / total) * track)
        const maxLeft = track - width
        const ratio = total - track > 0 ? scroller.scrollLeft / (total - track) : 0
        thumb.style.width = `${Math.round(width)}px`
        thumb.style.transform = `translateX(${Math.round(maxLeft * ratio)}px)`
      }
      const reveal = () => {
        scroller.classList.add('is-active')
        thumb.classList.add('is-visible')
        window.clearTimeout(timer)
        paint()
      }
      const settle = (delay: number) => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          scroller.classList.remove('is-active')
          thumb.classList.remove('is-visible')
        }, delay)
      }
      const onPointerMove = (event: PointerEvent) => {
        const box = scroller.getBoundingClientRect()
        if (event.clientY >= box.bottom - 16) reveal()
      }
      const onScroll = () => {
        reveal()
        settle(700)
      }
      const onLeave = () => settle(260)

      paint()
      scroller.addEventListener('pointermove', onPointerMove)
      scroller.addEventListener('scroll', onScroll, { passive: true })
      scroller.addEventListener('pointerleave', onLeave)
      cleanups.push(() => {
        window.clearTimeout(timer)
        scroller.removeEventListener('pointermove', onPointerMove)
        scroller.removeEventListener('scroll', onScroll)
        scroller.removeEventListener('pointerleave', onLeave)
        thumb.remove()
      })
    }

    return () => cleanups.forEach((run) => run())
  }, [text])

  return <div ref={host} className={className} />
}
