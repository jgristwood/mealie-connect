import { afterEach, describe, expect, it, vi } from 'vitest'
import { MealieClient } from '../services/mealie/mealie-client'
import { analyzeIngredients, findRecipesByIngredients, ingredientStem, ingredientTermPattern, isPantryStaple, matchesMode } from './ingredient-finder'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ingredientTermPattern', () => {
  it('matches whole words and simple plurals', () => {
    expect(ingredientTermPattern('egg')?.test('2 large eggs')).toBe(true)
    expect(ingredientTermPattern('egg')?.test('1 eggplant')).toBe(false)
    expect(ingredientTermPattern('tomatoes')?.test('1 tomato, diced')).toBe(true)
    expect(ingredientTermPattern('berry')?.test('1 cup mixed berries')).toBe(true)
    expect(ingredientTermPattern('Chicken')?.test('chicken thighs')).toBe(true)
    expect(ingredientStem('Eggs')).toBe('egg')
    expect(ingredientStem('berries')).toBe('berry')
  })
})

describe('isPantryStaple', () => {
  it('recognises salt, pepper, water and cooking oil', () => {
    expect(isPantryStaple('kosher salt')).toBe(true)
    expect(isPantryStaple('Salt and freshly ground black pepper, to taste')).toBe(true)
    expect(isPantryStaple('2 tbsp extra virgin olive oil')).toBe(true)
  })

  it('does not treat other peppers or oils as staples', () => {
    expect(isPantryStaple('bell pepper')).toBe(false)
    expect(isPantryStaple('chili oil')).toBe(false)
  })
})

describe('analyzeIngredients', () => {
  const stirFry = [
    { food: 'chicken breast' },
    { food: 'broccoli' },
    { food: 'garlic' },
    { food: 'olive oil' },
    { note: 'salt to taste' },
  ]

  it('reports a perfect match when only staples are left over', () => {
    const analysis = analyzeIngredients(stirFry, ['Chicken', 'Broccoli', 'Garlic'], true)
    expect(analysis).toEqual({ matched: ['Chicken', 'Broccoli', 'Garlic'], missing: [] })
  })

  it('lists missing ingredients and counts staples when asked to', () => {
    const analysis = analyzeIngredients(stirFry, ['Chicken'], false)
    expect(analysis.missing).toEqual(['broccoli', 'garlic', 'olive oil', 'salt to taste'])
  })

  it('applies ANY and ALL matching', () => {
    const analysis = analyzeIngredients(stirFry, ['Chicken', 'Rice'], true)
    expect(matchesMode(analysis, ['Chicken', 'Rice'], 'any')).toBe(true)
    expect(matchesMode(analysis, ['Chicken', 'Rice'], 'all')).toBe(false)
  })
})

describe('findRecipesByIngredients', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const recipes: Record<string, { id: string; name: string; slug: string; recipeIngredient: Array<{ food?: { name: string }; note?: string }> }> = {
    'stir-fry': { id: 'r1', name: 'Chicken Stir Fry', slug: 'stir-fry', recipeIngredient: [{ food: { name: 'chicken' } }, { food: { name: 'rice' } }] },
    'fried-rice': { id: 'r2', name: 'Chicken Fried Rice', slug: 'fried-rice', recipeIngredient: [{ food: { name: 'chicken' } }, { food: { name: 'rice' } }, { food: { name: 'peas' } }] },
    'chicken-soup': { id: 'r3', name: 'Chicken Soup', slug: 'chicken-soup', recipeIngredient: [{ note: '1 whole chicken' }, { note: '2 carrots' }] },
  }

  it('narrows with search and foods, then ranks by fewest missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/foods') return json({ items: [{ id: 'food-rice', name: url.searchParams.get('search') === 'rice' ? 'rice' : 'chicken' }] })
      if (url.pathname === '/api/recipes') {
        const search = url.searchParams.get('search')
        const all = Object.values(recipes).map(({ recipeIngredient: _ignored, ...summary }) => summary)
        if (search === 'chicken') return json({ items: all })
        if (search === 'rice') return json({ items: all.filter((recipe) => recipe.id !== 'r3') })
        return json({ items: [] })
      }
      const slug = url.pathname.split('/').pop() ?? ''
      return json(recipes[slug])
    })
    const client = new MealieClient({ baseUrl: 'http://finder.test', token: 'token' })

    const results = await findRecipesByIngredients(client, ['chicken', 'rice'], { mode: 'all' })

    expect(results.map((result) => [result.recipe.name, result.missing])).toEqual([
      ['Chicken Stir Fry', []],
      ['Chicken Fried Rice', ['peas']],
    ])
  })
})
