import { useDialogFocus } from './dialogFocus'

const ROWS: Array<[string, string]> = [
  ['j / k', 'next / previous skill'],
  ['n / p', 'next / previous that needs attention'],
  ['g g / G', 'first / last'],
  ['Space / Shift+Space', 'page the detail pane'],
  ['o or Enter', 'open the skill’s folder'],
  ['s', 'switch it on or off for this agent'],
  ['a then a', 'archive, twice within four seconds'],
  ['e / x', 'selection mode / toggle a row'],
  ['Shift+A', 'archive the selection'],
  ['1 - 6', 'all / needs attention / notifications / drafts / workspace / trash'],
  ['S / Y / P', 'sources / sync / appearance'],
  ['/', 'focus search'],
  ['v / w', 'preview or raw / wrap'],
  ['t', 'next theme'],
  ['u', 'undo the last entry'],
  ['?', 'this map'],
  ['Escape', 'close a menu, close the dialog on top, clear search']
]

/**
 * The map is its own component so its focus trap mounts with it. A trap created in the parent runs
 * once, when the dialog does not exist yet, and quietly does nothing.
 */
export function KeysMap({ onClose }: { onClose: () => void }) {
  const panel = useDialogFocus<HTMLDivElement>()
  return (
    <div className="modal-backdrop" role="dialog" aria-label="Keyboard map" aria-modal="true" onClick={onClose}>
      <div className="keysdlg" ref={panel} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="sdhead">
          <div>
            <div className="mergetitle">Keyboard</div>
            <div className="mergesub">The list is the spine. Nothing here moves the page under you.</div>
          </div>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="keysgrid">
          {ROWS.map(([keys, what]) => (
            <div className="keysrow" key={keys}>
              <kbd>{keys}</kbd>
              <span>{what}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
