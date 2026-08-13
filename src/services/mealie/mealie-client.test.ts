import { afterEach, describe, expect, it, vi } from 'vitest'
import { MealieClient } from './mealie-client'

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
      body: JSON.stringify({ food: 'Tomatoes', shoppingListId: 'list-1' }),
    }))
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://mealie.test/api/households/shopping/lists/list-1')
  })
})
