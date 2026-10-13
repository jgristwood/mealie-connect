import { useCallback, useEffect, useRef, useState } from 'react'

export interface CookTimer {
  id: string
  label: string
  totalSeconds: number
  /** Epoch ms when the timer ends; undefined while paused. */
  endsAt?: number
  /** Seconds left when paused. */
  remainingWhenPaused?: number
  finished: boolean
}

let audioContext: AudioContext | undefined

/** Creating the AudioContext during a tap lets the alarm play later. */
function primeAudio(): void {
  try {
    audioContext ??= new AudioContext()
    void audioContext.resume()
  } catch {
    // Audio unavailable; the visual and vibration alerts still work.
  }
}

function playAlarm(): void {
  try {
    navigator.vibrate?.([300, 150, 300, 150, 300])
  } catch {
    // Vibration unsupported.
  }
  if (!audioContext) return
  const start = audioContext.currentTime
  for (let beep = 0; beep < 3; beep += 1) {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, start + beep * 0.45)
    gain.gain.exponentialRampToValueAtTime(0.3, start + beep * 0.45 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + beep * 0.45 + 0.3)
    oscillator.connect(gain).connect(audioContext.destination)
    oscillator.start(start + beep * 0.45)
    oscillator.stop(start + beep * 0.45 + 0.32)
  }
}

export function remainingSeconds(timer: CookTimer, now: number): number {
  if (timer.finished) return 0
  if (timer.endsAt === undefined) return timer.remainingWhenPaused ?? timer.totalSeconds
  return Math.max(0, (timer.endsAt - now) / 1000)
}

/** Kitchen timers that keep counting while the cook moves between steps.
 * Timers track their end time rather than counting ticks, so they stay
 * accurate if the screen sleeps or the app is backgrounded. */
export function useCookTimers() {
  const [timers, setTimers] = useState<CookTimer[]>([])
  const [now, setNow] = useState(() => Date.now())
  const nextId = useRef(0)

  const hasRunning = timers.some((timer) => !timer.finished && timer.endsAt !== undefined)

  useEffect(() => {
    if (!hasRunning) return
    const interval = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(interval)
  }, [hasRunning])

  useEffect(() => {
    const due = timers.filter((timer) => !timer.finished && timer.endsAt !== undefined && timer.endsAt <= now)
    if (due.length === 0) return
    playAlarm()
    setTimers((current) => current.map((timer) => (due.some((dueTimer) => dueTimer.id === timer.id) ? { ...timer, finished: true } : timer)))
  }, [now, timers])

  const start = useCallback((label: string, seconds: number) => {
    primeAudio()
    nextId.current += 1
    const id = `timer-${nextId.current}`
    setNow(Date.now())
    setTimers((current) => [...current, { id, label, totalSeconds: seconds, endsAt: Date.now() + seconds * 1000, finished: false }])
  }, [])

  const togglePause = useCallback((id: string) => {
    primeAudio()
    const at = Date.now()
    setNow(at)
    setTimers((current) => current.map((timer) => {
      if (timer.id !== id || timer.finished) return timer
      if (timer.endsAt === undefined) {
        return { ...timer, endsAt: at + (timer.remainingWhenPaused ?? timer.totalSeconds) * 1000, remainingWhenPaused: undefined }
      }
      return { ...timer, endsAt: undefined, remainingWhenPaused: Math.max(0, (timer.endsAt - at) / 1000) }
    }))
  }, [])

  const dismiss = useCallback((id: string) => {
    setTimers((current) => current.filter((timer) => timer.id !== id))
  }, [])

  return { timers, now, start, togglePause, dismiss }
}
