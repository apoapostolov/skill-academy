import { THEMES, worstContrast, type Theme } from './themes'
import { useDialogFocus } from './dialogFocus'

/**
 * Twelve themes, each shown as the thing it actually is: a palette with a background, a surface, a
 * text colour and an accent, plus the worst contrast ratio it puts on screen. The ratio is not
 * decoration — it is the number the gate enforces, shown so a choice is informed rather than felt.
 */
export function AppearanceDialog({
  current,
  onPick,
  onClose
}: {
  current: string
  onPick: (theme: Theme) => void
  onClose: () => void
}) {
  const panel = useDialogFocus<HTMLDivElement>()
  return (
    <div className="modal-backdrop" role="dialog" aria-label="Appearance" aria-modal="true">
      <div className="appearancedlg" ref={panel} tabIndex={-1}>
        <div className="sdhead">
          <div>
            <div className="mergetitle">Appearance</div>
            <div className="mergesub">
              Every theme is checked for contrast before it ships. The number is the worst pair it puts on screen.
            </div>
          </div>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="themes">
          {THEMES.map((theme) => {
            const worst = worstContrast(theme)
            return (
              <button
                key={theme.id}
                type="button"
                className={`themecard ${current === theme.id ? 'on' : ''}`}
                aria-pressed={current === theme.id}
                onClick={() => onPick(theme)}
                style={{ background: theme.tokens.bg, color: theme.tokens.text, borderColor: theme.tokens.sep }}
              >
                <span className="themeswatch" aria-hidden="true">
                  <span style={{ background: theme.tokens.surface }} />
                  <span style={{ background: theme.tokens.accent }} />
                  <span style={{ background: theme.tokens['text-2'] }} />
                </span>
                <span className="themename">{theme.name}</span>
                <span className="thememeta" style={{ color: theme.tokens['text-2'] }}>
                  {theme.mode} · {Math.round(worst.ratio * 10) / 10}:1
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
