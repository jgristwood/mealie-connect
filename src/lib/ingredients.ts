import type { MealieIngredient } from '../types/mealie'

const FRACTIONS: Array<[number, string]> = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [3 / 8, '⅜'],
  [1 / 2, '½'],
  [5 / 8, '⅝'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [7 / 8, '⅞'],
]

/** Formats a quantity for cooking: whole numbers stay whole, common kitchen
 * fractions are shown as ½, ⅓ etc., everything else is rounded sensibly. */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const whole = Math.floor(value)
  const remainder = value - whole
  if (remainder < 0.02) return String(whole)
  if (remainder > 0.98) return String(whole + 1)
  const match = FRACTIONS.find(([fraction]) => Math.abs(remainder - fraction) < 0.02)
  if (match) return whole > 0 ? `${whole}${match[1]}` : match[1]
  return String(Number(value.toFixed(value < 10 ? 2 : 1)))
}

function numericQuantity(quantity: MealieIngredient['quantity']): number | undefined {
  const value = typeof quantity === 'string' ? Number.parseFloat(quantity) : quantity
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** The ingredient line exactly as Mealie displays it. */
export function ingredientDisplayText(ingredient: MealieIngredient): string {
  return ingredient.display
    ?? ingredient.note
    ?? `${ingredient.quantity ?? ''} ${ingredient.unit ?? ''} ${ingredient.food ?? ''}`.replace(/\s+/g, ' ').trim()
}

/** Returns the ingredient line with its quantity multiplied by `scale`.
 * Ingredients without a parsed quantity and food/unit (e.g. free-text notes
 * like "Salt to taste") are returned unchanged because they can't be scaled. */
export function scaleIngredientText(ingredient: MealieIngredient, scale: number): string {
  const original = ingredientDisplayText(ingredient)
  if (scale === 1) return original
  const quantity = numericQuantity(ingredient.quantity)
  if (quantity === undefined || (!ingredient.food && !ingredient.unit)) return original
  const parts = [formatQuantity(quantity * scale), ingredient.unit, ingredient.food].filter(Boolean).join(' ')
  return ingredient.note ? `${parts}, ${ingredient.note}` : parts
}

export function canScaleIngredient(ingredient: MealieIngredient): boolean {
  return numericQuantity(ingredient.quantity) !== undefined && Boolean(ingredient.food || ingredient.unit)
}
