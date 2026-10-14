import type { MealieClient, RecipeQueryFilters } from '../services/mealie/mealie-client'
import { settleWithConcurrency } from './concurrency'
import type { IngredientMatchMode, MealieIngredient, MealieRecipeDetail, MealieRecipeSummary } from '../types/mealie'

/** Words that make up the ingredients most kitchens always have (salt,
 * pepper, water, cooking oil). These don't count as "missing". */
const STAPLE_WORDS = new Set(['salt', 'pepper', 'peppercorns', 'water', 'oil', 'olive', 'vegetable', 'canola', 'sunflower', 'cooking', 'spray', 'ice'])
/** Descriptions, amounts and units that can surround a staple. */
const STAPLE_FILLER = new Set([
  'kosher', 'sea', 'table', 'fine', 'flaky', 'black', 'white', 'ground', 'freshly', 'fresh', 'cracked', 'extra', 'virgin', 'light',
  'and', 'or', 'to', 'taste', 'for', 'frying', 'greasing', 'the', 'pan', 'cold', 'warm', 'hot', 'boiling', 'lukewarm', 'of', 'a',
  'pinch', 'dash', 'as', 'needed', 'more', 'plus', 'some', 'little', 'about', 'tsp', 'teaspoon', 'teaspoons', 'tbsp', 'tablespoon',
  'tablespoons', 'cup', 'cups', 'ml', 'l', 'liter', 'liters', 'litre', 'litres', 'g', 'oz', 'quart', 'quarts', 'cubes', 'cube',
])

export function isPantryStaple(label: string): boolean {
  const words = label.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  const core = words.filter((word) => !STAPLE_FILLER.has(word))
  return core.length > 0 && core.every((word) => STAPLE_WORDS.has(word))
}

export interface IngredientAnalysis {
  /** The cook's ingredients that this recipe uses. */
  matched: string[]
  /** Recipe ingredients the cook didn't list (pantry staples excluded when asked). */
  missing: string[]
}

export interface IngredientFinderResult extends IngredientAnalysis {
  recipe: MealieRecipeSummary
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The singular form of an ingredient name: "tomatoes" -> "tomato". */
export function ingredientStem(term: string): string {
  const cleaned = term.toLowerCase().trim().replace(/\s+/g, ' ')
  if (/[^aeiou]ies$/.test(cleaned)) return `${cleaned.slice(0, -3)}y`
  if (/(ch|sh|x|o)es$/.test(cleaned)) return cleaned.slice(0, -2)
  if (/[^s]s$/.test(cleaned)) return cleaned.slice(0, -1)
  return cleaned
}

/** Text to send to Mealie's substring search so it finds every plural form
 * ("berr" finds berry and berries). Results are checked word by word later. */
function serverSearchText(term: string): string {
  const stem = ingredientStem(term)
  return stem.endsWith('y') && stem.length > 3 ? stem.slice(0, -1) : stem
}

/** Builds a whole-word matcher that also accepts simple plurals, so "egg"
 * matches "eggs" (but not "eggplant") and "tomatoes" matches "tomato". */
export function ingredientTermPattern(term: string): RegExp | null {
  const stem = ingredientStem(term)
  if (!stem) return null
  const forms = [escapeRegExp(stem)]
  if (stem.endsWith('y')) forms.push(`${escapeRegExp(stem.slice(0, -1))}ies`)
  return new RegExp(`\\b(?:${forms.join('|')})(?:e?s)?\\b`, 'i')
}

function ingredientText(ingredient: MealieIngredient): string {
  return [ingredient.food, ingredient.note, ingredient.display].filter(Boolean).join(' ')
}

function ingredientLabel(ingredient: MealieIngredient): string {
  return (ingredient.food || ingredient.note || ingredient.display || '').trim()
}

/** Compares a recipe's ingredients with what the cook has on hand. */
export function analyzeIngredients(ingredients: MealieIngredient[], have: string[], ignoreStaples: boolean): IngredientAnalysis {
  const havePatterns = have.map((term) => ({ term, pattern: ingredientTermPattern(term) }))
  const matched = new Set<string>()
  const missing: string[] = []

  for (const ingredient of ingredients) {
    const text = ingredientText(ingredient)
    if (!text.trim()) continue
    let covered = false
    for (const { term, pattern } of havePatterns) {
      if (pattern?.test(text)) { matched.add(term); covered = true }
    }
    if (covered) continue
    const label = ingredientLabel(ingredient)
    if (ignoreStaples && isPantryStaple(ingredient.food || label)) continue
    missing.push(label)
  }

  return { matched: have.filter((term) => matched.has(term)), missing }
}

export function matchesMode(analysis: IngredientAnalysis, have: string[], mode: IngredientMatchMode): boolean {
  if (have.length === 0) return true
  return mode === 'all' ? analysis.matched.length === have.length : analysis.matched.length > 0
}

/** Best matches first: fewest missing ingredients, then most of yours used. */
export function compareFinderResults(a: IngredientFinderResult, b: IngredientFinderResult): number {
  return a.missing.length - b.missing.length
    || b.matched.length - a.matched.length
    || a.recipe.name.localeCompare(b.recipe.name)
}

const DETAIL_CONCURRENCY = 6
const detailCache = new Map<string, MealieRecipeDetail>()

function detailCacheKey(client: MealieClient, recipe: MealieRecipeSummary): string {
  const updated = (recipe as { dateUpdated?: string; updatedAt?: string; updateAt?: string }).dateUpdated
    ?? (recipe as { updatedAt?: string }).updatedAt
    ?? (recipe as { updateAt?: string }).updateAt
    ?? ''
  return `${client.baseUrl}|${client.token ?? ''}|${recipe.id}|${updated}`
}

async function getRecipeDetailCached(client: MealieClient, recipe: MealieRecipeSummary): Promise<MealieRecipeDetail> {
  const key = detailCacheKey(client, recipe)
  const cached = detailCache.get(key)
  if (cached) return cached
  const detail = await client.getRecipe(recipe.slug || recipe.id)
  detailCache.set(key, detail)
  return detail
}

/** Recipes that might use `term`: Mealie's text search (which covers
 * ingredient text) plus recipes whose parsed foods match the term. */
async function candidatesForTerm(client: MealieClient, term: string, filters: RecipeQueryFilters): Promise<MealieRecipeSummary[]> {
  const pattern = ingredientTermPattern(term)
  const searchText = serverSearchText(term)
  const [searchResult, foodsResult] = await Promise.allSettled([
    client.getAllRecipes({ ...filters, search: searchText }),
    client.getFoods(searchText).then((foods) => {
      const ids = foods.filter((food) => pattern?.test(food.name)).map((food) => food.id)
      return ids.length > 0 ? client.getAllRecipes({ ...filters, search: undefined, foods: ids }) : []
    }),
  ])
  if (searchResult.status === 'rejected' && foodsResult.status === 'rejected') throw searchResult.reason
  const byId = new Map<string, MealieRecipeSummary>()
  for (const result of [searchResult, foodsResult]) {
    if (result.status === 'fulfilled') for (const recipe of result.value) byId.set(recipe.id, recipe)
  }
  return [...byId.values()]
}

export interface FindRecipesOptions {
  mode: IngredientMatchMode
  ignoreStaples?: boolean
  /** Other filters (categories, tags, times, and an optional text search). */
  filters?: RecipeQueryFilters
  onProgress?: (done: number, total: number) => void
  signal?: { cancelled: boolean }
}

/** Finds recipes that use the ingredients the cook has. Narrows candidates on
 * the server first, then checks each candidate's full ingredient list. */
export async function findRecipesByIngredients(client: MealieClient, have: string[], options: FindRecipesOptions): Promise<IngredientFinderResult[]> {
  const terms = [...new Set(have.map((term) => term.trim()).filter(Boolean))]
  if (terms.length === 0) return []
  const { search, ...filters } = options.filters ?? {}

  const perTerm = await Promise.all(terms.map((term) => candidatesForTerm(client, term, filters)))
  const termSets = perTerm.map((recipes) => new Set(recipes.map((recipe) => recipe.id)))
  const byId = new Map<string, MealieRecipeSummary>()
  for (const recipes of perTerm) for (const recipe of recipes) byId.set(recipe.id, recipe)

  let candidates = [...byId.values()]
  if (options.mode === 'all') candidates = candidates.filter((recipe) => termSets.every((set) => set.has(recipe.id)))
  if (search?.trim()) {
    const searchIds = new Set((await client.getAllRecipes({ ...filters, search })).map((recipe) => recipe.id))
    candidates = candidates.filter((recipe) => searchIds.has(recipe.id))
  }

  let done = 0
  options.onProgress?.(0, candidates.length)
  const details = await settleWithConcurrency(candidates, DETAIL_CONCURRENCY, async (recipe) => {
    if (options.signal?.cancelled) throw new Error('cancelled')
    const detail = await getRecipeDetailCached(client, recipe)
    done += 1
    options.onProgress?.(done, candidates.length)
    return detail
  })

  const results: IngredientFinderResult[] = []
  candidates.forEach((recipe, index) => {
    const detail = details[index]
    if (detail?.status !== 'fulfilled') return
    const analysis = analyzeIngredients(detail.value.ingredients ?? [], terms, options.ignoreStaples ?? true)
    if (matchesMode(analysis, terms, options.mode)) results.push({ recipe, ...analysis })
  })
  return results.sort(compareFinderResults)
}
