export interface DetectedDuration {
  /** The text as written in the step, e.g. "10-12 minutes". */
  label: string
  /** Timer length in seconds. For ranges this is the lower bound, so the cook
   * checks early rather than late. */
  seconds: number
}

const UNIT_SECONDS: Record<string, number> = { hour: 3600, minute: 60, second: 1 }

function unitKey(unit: string): keyof typeof UNIT_SECONDS {
  const lower = unit.toLowerCase()
  if (lower.startsWith('h')) return 'hour'
  if (lower.startsWith('s')) return 'second'
  return 'minute'
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?|½|¼|¾|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|forty|forty-five`
const UNIT = String.raw`hours?|hrs?|minutes?|mins?|seconds?|secs?`
const DURATION = new RegExp(
  String.raw`\b(${NUMBER})(?:\s*(?:-|–|to)\s*(${NUMBER}))?\s*(${UNIT})\b(?:\s*(?:and\s*)?(\d+)\s*(minutes?|mins?)\b)?`,
  'gi',
)

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, '½': 0.5, '¼': 0.25, '¾': 0.75,
}

function parseNumber(value: string): number {
  const word = WORD_NUMBERS[value.toLowerCase()]
  return word ?? Number.parseFloat(value.replace(',', '.'))
}

/** Finds cooking durations in an instruction ("simmer for 10-12 minutes",
 * "bake 1 hour 15 minutes") so they can be offered as one-tap timers. */
export function detectDurations(text: string): DetectedDuration[] {
  const results: DetectedDuration[] = []
  for (const match of text.matchAll(DURATION)) {
    const [label, first, , unit, extraMinutes] = match
    if (!first || !unit) continue
    let seconds = parseNumber(first) * UNIT_SECONDS[unitKey(unit)]!
    if (extraMinutes) seconds += Number.parseInt(extraMinutes, 10) * 60
    seconds = Math.round(seconds)
    if (seconds <= 0 || seconds > 24 * 3600) continue
    if (results.some((existing) => existing.seconds === seconds)) continue
    results.push({ label: label.trim(), seconds })
  }
  return results
}

/** Formats seconds as m:ss or h:mm:ss for a countdown display. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.ceil(totalSeconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}
