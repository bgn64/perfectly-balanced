import type { StatusPresentation } from './status.ts'

export function Statusline({
  presentation,
}: {
  presentation: StatusPresentation
}) {
  return (
    <footer className="statusline">
      <div>
        <strong>{presentation.mode}</strong>
        <span>{presentation.label}</span>
      </div>
      {presentation.shortcuts.length > 0 && (
        <div>
          {presentation.shortcuts.map((shortcut) => (
            <span key={`${shortcut.keys.join('+')}-${shortcut.label}`}>
              {shortcut.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}{' '}
              {shortcut.label}
            </span>
          ))}
        </div>
      )}
    </footer>
  )
}