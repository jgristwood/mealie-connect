import { afterEach, describe, expect, it, vi } from 'vitest'
import { MealieClient, groupMealPlanEntriesIntoSlots, parseMealieTimeToMinutes } from './mealie-client'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MealieClient', () => {
  it('normalizes paginated recipe responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ items: [{ id: 'recipe-1', name: 'Soup', slug: 'soup' }], total: 1 }),
    )
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    await expect(client.getRecipes()).resolves.toEqual([{ id: 'recipe-1', name: 'Soup', slug: 'soup' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mealie.test/api/recipes?page=1&perPage=50',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    )
  })

  it('normalizes Mealie recipe detail fields for the recipe view', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        id: 'recipe-2',
        name: 'Salmon Casserole',
        slug: 'salmon-casserole',
        image: 'cover.jpg',
        recipeCategory: [{ id: 'category-1', name: 'Dinner' }],
        recipeIngredient: [{ quantity: 2, unit: { name: 'cups' }, food: { name: 'potatoes' }, display: '2 cups potatoes' }],
        recipeInstructions: [{ summary: 'Bake until golden' }],
      }),
    )
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    await expect(client.getRecipe('salmon-casserole')).resolves.toMatchObject({
      categories: [{ name: 'Dinner' }],
      ingredients: [{ food: 'potatoes', unit: 'cups' }],
      instructions: [{ text: 'Bake until golden' }],
      image: 'http://mealie.test/api/media/recipes/recipe-2/images/original.webp',
    })
  })

  it('uses organizer endpoints for categories and tags', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'category-1', name: 'Dinner' }] }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'tag-1', name: 'Quick' }]))
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    await client.getCategories()
    await client.getTags()

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://mealie.test/api/organizers/categories')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://mealie.test/api/organizers/tags')
  })

  it('creates a meal-plan entry using the household endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ id: 4, date: '2026-08-15', entryType: 'dinner', title: 'Pasta' }),
    )
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    await expect(
      client.createMealPlanEntry({ date: '2026-08-15', entryType: 'dinner', title: 'Pasta' }),
    ).resolves.toMatchObject({ id: 4, title: 'Pasta' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://mealie.test/api/households/mealplans',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ date: '2026-08-15', entryType: 'dinner', title: 'Pasta' }) }),
    )
  })

  it('creates shopping items through the standalone item endpoint and refreshes the list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'item-1', food: 'Tomatoes' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'list-1', name: 'Groceries', items: [{ id: 'item-1', food: 'Tomatoes' }] }))
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    await expect(client.addToShoppingList('list-1', { food: 'Tomatoes' })).resolves.toMatchObject({ id: 'list-1' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://mealie.test/api/households/shopping/items')
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        shoppingListId: 'list-1',
        quantity: 1,
        unit: null,
        food: { name: 'Tomatoes' },
        note: null,
        display: 'Tomatoes',
      }),
    }))
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://mealie.test/api/households/shopping/lists/list-1')
  })

  it('filters recipes by max prep/cook time client-side', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        { id: '1', name: 'Quick soup', prepTime: 'PT10M', cookTime: 'PT15M' },
        { id: '2', name: 'Slow roast', prepTime: 'PT30M', cookTime: 'PT120M' },
      ]),
    )
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    await expect(client.getRecipes({ maxPrepTime: 20, maxCookTime: 30 })).resolves.toEqual([
      { id: '1', name: 'Quick soup', prepTime: 'PT10M', cookTime: 'PT15M' },
    ])
  })

  it('getAllRecipes pages through the full result set', async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({ id: `r${index}`, name: `Recipe ${index}` }))
    const page2 = [{ id: 'r100', name: 'Recipe 100' }]
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2))
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    const all = await client.getAllRecipes()
    expect(all).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('adds a recipe’s ingredients to a shopping list through the recipe endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ id: 'list-1', name: 'Weekly', items: [{ id: 'item-1' }] }))
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    const result = await client.addRecipeIngredientsToShoppingList('list-1', 'recipe-1')

    expect(result).toMatchObject({ id: 'list-1', name: 'Weekly' })
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ recipeIncrementQuantity: 1 }),
    }))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://mealie.test/api/households/shopping/lists/list-1/recipe/recipe-1')
  })

  it('removes all items from a shopping list by deleting each item then refreshing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ id: 'list-1', name: 'Weekly', items: [] }))
    const client = new MealieClient({ baseUrl: 'http://mealie.test', token: 'token' })

    await expect(client.removeAllFromShoppingList('list-1', ['item-1', 'item-2'])).resolves.toMatchObject({
      id: 'list-1',
      items: [],
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://mealie.test/api/households/shopping/items/item-1')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://mealie.test/api/households/shopping/items/item-2')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://mealie.test/api/households/shopping/lists/list-1')
  })
})

describe('parseMealieTimeToMinutes', () => {
  it('parses ISO 8601 durations', () => {
    expect(parseMealieTimeToMinutes('PT1H30M')).toBe(90)
    expect(parseMealieTimeToMinutes('PT20M')).toBe(20)
  })

  it('parses plain numeric strings and numbers', () => {
    expect(parseMealieTimeToMinutes('45')).toBe(45)
    expect(parseMealieTimeToMinutes(15)).toBe(15)
  })

  it('returns undefined for empty/invalid values', () => {
    expect(parseMealieTimeToMinutes(undefined)).toBeUndefined()
    expect(parseMealieTimeToMinutes('')).toBeUndefined()
    expect(parseMealieTimeToMinutes('not-a-time')).toBeUndefined()
  })
})

describe('groupMealPlanEntriesIntoSlots', () => {
  it('groups multiple recipes into a single date + meal-type slot', () => {
    const entries = [
      { id: '1', date: '2026-08-17', entryType: 'dinner', recipe: { name: 'Chicken Parmesan' } },
      { id: '2', date: '2026-08-17', entryType: 'dinner', recipe: { name: 'Garlic Bread' } },
      { id: '3', date: '2026-08-17', entryType: 'breakfast', recipe: { name: 'Pancakes' } },
    ] as never

    const slots = groupMealPlanEntriesIntoSlots(entries)
    expect(slots).toHaveLength(2)

    const dinnerSlot = slots.find((slot) => slot.entryType === 'dinner')
    expect(dinnerSlot?.entries).toHaveLength(2)
    expect(dinnerSlot?.entries.map((entry) => entry.recipe?.name)).toEqual(['Chicken Parmesan', 'Garlic Bread'])

    const breakfastSlot = slots.find((slot) => slot.entryType === 'breakfast')
    expect(breakfastSlot?.entries).toHaveLength(1)
  })

  it('keeps removing one entry from not affecting other entries in the same slot', () => {
    const entries = [
      { id: '1', date: '2026-08-17', entryType: 'dinner', recipe: { name: 'Chicken Parmesan' } },
      { id: '2', date: '2026-08-17', entryType: 'dinner', recipe: { name: 'Garlic Bread' } },
      { id: '3', date: '2026-08-17', entryType: 'dinner', recipe: { name: 'Caesar Salad' } },
    ]

    const withoutGarlicBread = entries.filter((entry) => entry.id !== '2')
    const slots = groupMealPlanEntriesIntoSlots(withoutGarlicBread as never)
    expect(slots[0]?.entries.map((entry) => entry.recipe?.name)).toEqual(['Chicken Parmesan', 'Caesar Salad'])
  })
})
