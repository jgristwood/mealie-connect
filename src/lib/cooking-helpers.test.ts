import { describe, expect, it } from 'vitest'
import { formatQuantity, scaleIngredientText } from './ingredients'
import { detectDurations, formatCountdown } from './timers'

describe('formatQuantity', () => {
  it('shows whole numbers and kitchen fractions', () => {
    expect(formatQuantity(2)).toBe('2')
    expect(formatQuantity(0.5)).toBe('½')
    expect(formatQuantity(1.333)).toBe('1⅓')
    expect(formatQuantity(2.75)).toBe('2¾')
    expect(formatQuantity(1.1)).toBe('1.1')
  })
})

describe('scaleIngredientText', () => {
  const flour = { quantity: 2, unit: 'cups', food: 'flour', display: '2 cups flour' }

  it('keeps Mealie display text at the original scale', () => {
    expect(scaleIngredientText(flour, 1)).toBe('2 cups flour')
  })

  it('multiplies parsed quantities', () => {
    expect(scaleIngredientText(flour, 1.5)).toBe('3 cups flour')
    expect(scaleIngredientText({ ...flour, note: 'sifted' }, 0.25)).toBe('½ cups flour, sifted')
  })

  it('leaves unparsed or note-only ingredients alone', () => {
    expect(scaleIngredientText({ note: 'Salt to taste', quantity: 1, display: 'Salt to taste' }, 2)).toBe('Salt to taste')
    expect(scaleIngredientText({ quantity: 0, food: 'pepper', display: 'pepper' }, 2)).toBe('pepper')
  })
})

describe('detectDurations', () => {
  it('finds minutes, hours, and ranges', () => {
    expect(detectDurations('Simmer for 10-12 minutes, then rest 5 mins.')).toEqual([
      { label: '10-12 minutes', seconds: 600 },
      { label: '5 mins', seconds: 300 },
    ])
    expect(detectDurations('Bake 1 hour 15 minutes until golden.')).toEqual([{ label: '1 hour 15 minutes', seconds: 4500 }])
    expect(detectDurations('Roast for an hour.')).toEqual([{ label: 'an hour', seconds: 3600 }])
  })

  it('ignores temperatures and plain numbers', () => {
    expect(detectDurations('Preheat to 350 F and add 2 eggs.')).toEqual([])
  })
})

describe('formatCountdown', () => {
  it('formats short and long countdowns', () => {
    expect(formatCountdown(65)).toBe('1:05')
    expect(formatCountdown(3725)).toBe('1:02:05')
    expect(formatCountdown(-3)).toBe('0:00')
  })
})
