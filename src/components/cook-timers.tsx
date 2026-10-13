import { useState } from 'react'
import { Pause, Play, Timer, X } from 'lucide-react'
import { detectDurations, formatCountdown } from '../lib/timers'
import { remainingSeconds, type CookTimer } from '../lib/use-cook-timers'

export function TimerTray({ timers, now, onTogglePause, onDismiss }: {
  timers: CookTimer[]
  now: number
  onTogglePause: (id: string) => void
  onDismiss: (id: string) => void
}) {
  if (timers.length === 0) return null
  return (
    <div className="cook-timer-tray" role="status" aria-live="polite">
      {timers.map((timer) => {
        const paused = !timer.finished && timer.endsAt === undefined
        return (
          <div key={timer.id} className={timer.finished ? 'cook-timer finished' : paused ? 'cook-timer paused' : 'cook-timer'}>
            <Timer className="cook-timer-icon" aria-hidden="true" />
            <span className="cook-timer-label">{timer.label}</span>
            <span className="cook-timer-time">{timer.finished ? 'Done!' : formatCountdown(remainingSeconds(timer, now))}</span>
            {!timer.finished ? (
              <button type="button" className="cook-timer-btn" onClick={() => onTogglePause(timer.id)} aria-label={paused ? `Resume ${timer.label} timer` : `Pause ${timer.label} timer`}>
                {paused ? <Play /> : <Pause />}
              </button>
            ) : null}
            <button type="button" className="cook-timer-btn" onClick={() => onDismiss(timer.id)} aria-label={`Dismiss ${timer.label} timer`}>
              <X />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** One-tap timers for each duration found in the step, plus a custom timer. */
export function StepTimerButtons({ stepText, stepLabel, onStart }: {
  stepText: string
  stepLabel: string
  onStart: (label: string, seconds: number) => void
}) {
  const [customOpen, setCustomOpen] = useState(false)
  const [customMinutes, setCustomMinutes] = useState('')
  const detected = detectDurations(stepText)

  const startCustom = () => {
    const minutes = Number.parseFloat(customMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return
    onStart(`${stepLabel} · ${minutes} min`, Math.round(minutes * 60))
    setCustomMinutes('')
    setCustomOpen(false)
  }

  return (
    <div className="cook-step-timers">
      {detected.map((duration) => (
        <button key={duration.label} type="button" className="chip cook-timer-chip" onClick={() => onStart(`${stepLabel} · ${duration.label}`, duration.seconds)}>
          <Timer size={14} aria-hidden="true" /> Start {duration.label} timer
        </button>
      ))}
      {customOpen ? (
        <form className="cook-custom-timer" onSubmit={(event) => { event.preventDefault(); startCustom() }}>
          <input type="number" min={0} step="any" inputMode="decimal" value={customMinutes} onChange={(event) => setCustomMinutes(event.target.value)} placeholder="Minutes" aria-label="Custom timer length in minutes" autoFocus />
          <button type="submit" className="btn-primary btn-sm">Start</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setCustomOpen(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="chip" onClick={() => setCustomOpen(true)}>
          <Timer size={14} aria-hidden="true" /> {detected.length > 0 ? 'Other timer' : 'Set a timer'}
        </button>
      )}
    </div>
  )
}
