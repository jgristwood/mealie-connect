import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MealieClient, OfflineError } from './mealie-client'
import { getSyncStatus, updateSyncStatus } from '../../lib/sync-status'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const offline = () => Promise.reject(new TypeError('Failed to fetch'))

let accountNumber = 0
/** A fresh account per test, so device copies don't leak between tests. */
function newClient() {
  accountNumber += 1
  return new MealieClient({ baseUrl: 'http://mealie.test', token: `token-${accountNumber}` })
}

beforeEach(() => {
  updateSyncStatus({ pending: 0, offline: false, syncing: false, failed: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('offline reads', () => {
  it('answers from the device copy when Mealie cannot be reached', async () => {
    const client = newClient()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ id: 'list-1', name: 'Groceries', listItems: [{ id: 'a', display: 'Apples' }] }))
    await client.getShoppingList('list-1')

    fetchMock.mockImplementation(offline)
    await expect(client.getShoppingList('list-1')).resolves.toMatchObject({ name: 'Groceries', items: [{ display: 'Apples' }] })
    expect(getSyncStatus().offline).toBe(true)
  })

  it('treats a proxy 502 as unreachable', async () => {
    const client = newClient()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json([{ id: 'c1', name: 'Dinner' }])).mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
    await client.getCategories()
    await expect(client.getCategories()).resolves.toEqual([{ id: 'c1', name: 'Dinner' }])
  })

  it('explains when nothing was saved on the device', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(offline)
    await expect(newClient().getRecipe('never-opened')).rejects.toThrow("hasn't been saved on this device")
  })

  it('searches saved recipes, including their ingredients, while offline', async () => {
    const client = newClient()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ items: [{ id: 'r1', name: 'Stir Fry', slug: 'stir-fry' }, { id: 'r2', name: 'Pancakes', slug: 'pancakes' }] }))
      .mockResolvedValueOnce(json({ id: 'r1', name: 'Stir Fry', slug: 'stir-fry', recipeIngredient: [{ food: { id: 'f1', name: 'broccoli' } }] }))
    await client.getRecipes()
    await client.getRecipe('stir-fry')

    fetchMock.mockImplementation(offline)
    await expect(client.getRecipes({ search: 'broccoli' })).resolves.toMatchObject([{ name: 'Stir Fry' }])
    await expect(client.getRecipes({ foods: ['f1'] })).resolves.toMatchObject([{ name: 'Stir Fry' }])
    await expect(client.getRecipes()).resolves.toHaveLength(2)
  })
})

describe('offline changes', () => {
  it('queues shopping changes, shows them right away, and sends them in order once online', async () => {
    const client = newClient()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({
      id: 'list-1', name: 'Groceries', listItems: [{ id: 'a', quantity: 2, food: { name: 'apples' }, note: '', checked: false, display: '2 apples' }],
    }))
    const list = await client.getShoppingList('list-1')
    const apples = list.items?.[0]
    if (!apples) throw new Error('missing item')

    fetchMock.mockImplementation(offline)
    const checked = await client.updateShoppingListItem('list-1', apples, { checked: true })
    expect(checked.items?.[0]).toMatchObject({ checked: true })
    const edited = await client.updateShoppingListItem('list-1', apples, { quantity: 5 })
    expect(edited.items?.[0]).toMatchObject({ checked: true, quantity: 5, display: '5 apples' })
    const added = await client.addToShoppingList('list-1', { note: 'Paper towels' })
    expect(added.items).toHaveLength(2)
    expect(getSyncStatus()).toMatchObject({ pending: 2, offline: true })

    const sent: Array<[string, string, unknown]> = []
    fetchMock.mockImplementation(async (input, init) => {
      sent.push([String(init?.method), String(input).replace('http://mealie.test', ''), init?.body ? JSON.parse(String(init.body)) : undefined])
      if (init?.method === 'POST') return json({ createdItems: [{ id: 'b' }] })
      if (init?.method === 'PUT') return json({ updatedItems: [{ id: 'a' }] })
      return json({ id: 'list-1', name: 'Groceries', listItems: [] })
    })

    await expect(client.flushIfPending()).resolves.toBe(2)
    expect(sent[0]).toEqual(['PUT', '/api/households/shopping/items/a', expect.objectContaining({ checked: true, quantity: 5, food: { name: 'apples' } })])
    expect(sent[1]).toEqual(['POST', '/api/households/shopping/items', expect.objectContaining({ note: 'Paper towels' })])
    expect(getSyncStatus().pending).toBe(0)
  })

  it('drops an item added and removed while offline instead of sending both', async () => {
    const client = newClient()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ id: 'list-1', name: 'Groceries', listItems: [] }))
    await client.getShoppingList('list-1')

    fetchMock.mockImplementation(offline)
    const added = await client.addToShoppingList('list-1', { note: 'Milk' })
    const milk = added.items?.[0]
    await client.removeFromShoppingList('list-1', milk?.id ?? '')
    await expect(client.getShoppingList('list-1')).resolves.toMatchObject({ items: [] })
    expect(getSyncStatus().pending).toBe(0)
  })

  it('plans meals offline and swaps in the real entry after syncing', async () => {
    const client = newClient()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ items: [] }))
    await client.getMealPlans('2026-10-01', '2026-10-31')

    fetchMock.mockImplementation(offline)
    const placeholder = await client.createMealPlanEntry({ date: '2026-10-14', entryType: 'snack', title: 'Apple slices' })
    expect(placeholder.id).toMatch(/^offline-/)
    await expect(client.getMealPlans('2026-10-01', '2026-10-31')).resolves.toMatchObject([{ title: 'Apple slices' }])

    fetchMock.mockImplementation(async (_input, init) => (init?.method === 'POST'
      ? json({ id: '42', date: '2026-10-14', entryType: 'snack', title: 'Apple slices' })
      : json({ items: [{ id: '42', date: '2026-10-14', entryType: 'snack', title: 'Apple slices' }] })))
    await client.flushIfPending()
    await expect(client.getMealPlans('2026-10-01', '2026-10-31')).resolves.toMatchObject([{ id: '42' }])
  })

  it('stops at the first change that still cannot be sent and keeps the rest', async () => {
    const client = newClient()
    vi.spyOn(globalThis, 'fetch').mockImplementation(offline)
    await client.markRecipeMade({ id: 'r1', slug: 'soup' }, 'Made it')
    await client.deleteMealPlanEntry('7')
    expect(getSyncStatus().pending).toBe(2)

    await expect(client.flushIfPending()).resolves.toBe(0)
    expect(getSyncStatus().pending).toBe(2)
  })

  it('does not hide errors that are not about connectivity', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ detail: 'nope' }, 401))
    const error = await newClient().getRecipes().catch((reason: unknown) => reason)
    expect(error).not.toBeInstanceOf(OfflineError)
    expect(String(error)).toContain('sign in again')
  })
})
