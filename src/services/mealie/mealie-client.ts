import type {
  MealieCategory,
  MealieRecipeDetail,
  MealieRecipeSummary,
  MealieShoppingList,
  MealieWeekPlan,
  MealieTag,
  PlannableMealType,
} from '../../types/mealie'

export interface MealieClientOptions {
  baseUrl: string
  token?: string
}

export interface RecipeQueryFilters {
  search?: string
  categories?: string[]
  tags?: string[]
  /** Maximum prep time, in minutes. Applied client-side since Mealie's list
   * endpoint does not expose a time-range filter across versions. */
  maxPrepTime?: number
  /** Maximum cook time, in minutes. Applied client-side (see above). */
  maxCookTime?: number
  page?: number
  perPage?: number
}

type MealieShoppingListResponse = MealieShoppingList & { listItems?: MealieShoppingList['items'] }

/** Parses a Mealie time value (which may be a number of minutes, an ISO 8601
 * duration such as "PT20M", or a free-form string) into whole minutes. */
export function parseMealieTimeToMinutes(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return value

  const isoMatch = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/i.exec(value.trim())
  if (isoMatch) {
    const days = Number(isoMatch[1] ?? 0)
    const hours = Number(isoMatch[2] ?? 0)
    const minutes = Number(isoMatch[3] ?? 0)
    return days * 24 * 60 + hours * 60 + minutes
  }

  const numeric = Number.parseInt(value, 10)
  return Number.isNaN(numeric) ? undefined : numeric
}

export class MealieClient {
  baseUrl: string
  token?: string

  constructor({ baseUrl, token }: MealieClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }

    return headers
  }

  private buildQueryString(params: Record<string, string | number | string[] | undefined>) {
    const search = new URLSearchParams()

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item) search.append(key, item)
        }
        continue
      }

      search.set(key, String(value))
    }

    const query = search.toString()
    return query ? `?${query}` : ''
  }

  private async safeJsonParse<T>(response: Response, errorMessage: string): Promise<T> {
    const text = await response.text()
    if (!text) {
      throw new Error(errorMessage)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      // If the response looks like an error from the proxy, extract it
      if (text.includes('Bad Gateway') || text.includes('Could not reach')) {
        throw new Error('Could not reach the Mealie server. Verify the proxy is running and the server URL is correct.')
      }
      throw new Error(`${errorMessage} (Invalid response format)`)
    }
  }

  private normalizeRecipeDetail(value: Record<string, unknown>): MealieRecipeDetail {
    const recipe = value as unknown as MealieRecipeDetail & {
      ingredients?: Array<Record<string, unknown>>
      instructions?: Array<Record<string, unknown>>
      recipeIngredient?: Array<Record<string, unknown>>
      recipeInstructions?: Array<Record<string, unknown>>
      recipeCategory?: MealieCategory[]
      image?: string | boolean | null
      orgURL?: string
    }
    const rawIngredients = recipe.ingredients ?? recipe.recipeIngredient ?? []
    const rawInstructions = recipe.instructions ?? recipe.recipeInstructions ?? []
    const ingredients = Array.isArray(rawIngredients)
      ? rawIngredients.map((ingredient) => {
          const rawFood = ingredient.food
          const rawUnit = ingredient.unit
          return {
            ...ingredient,
            food: typeof rawFood === 'string' ? rawFood : (rawFood as { name?: string } | undefined)?.name,
            unit: typeof rawUnit === 'string' ? rawUnit : (rawUnit as { name?: string } | undefined)?.name,
          }
        })
      : []
    const instructions = Array.isArray(rawInstructions)
      ? rawInstructions.map((instruction) => {
          const text = instruction.text ?? instruction.instruction ?? instruction.summary
          return {
            ...instruction,
            text: typeof text === 'string' ? text : undefined,
          }
        })
      : []
    const rawImage = recipe.image
    const image = typeof rawImage === 'string' && rawImage.startsWith('http')
      ? rawImage
      : rawImage
        ? `${this.baseUrl}/api/media/recipes/${encodeURIComponent(String(recipe.id))}/images/original.webp`
        : undefined

    return {
      ...recipe,
      image,
      ingredients,
      instructions,
      categories: recipe.categories ?? recipe.recipeCategory,
      totalTime: recipe.totalTime,
      prepTime: recipe.prepTime,
      cookTime: recipe.cookTime,
      url: recipe.url ?? recipe.orgURL,
    }
  }

  async loginWithPassword(username: string, password: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
      credentials: 'include',
    })

    if (!response.ok) {
      if (response.status === 0 || response.status === 401) {
        throw new Error('Your Mealie login credentials are invalid, or the server cannot be reached. Check the server URL and credentials.')
      }
      throw new Error('Your Mealie login is no longer valid. Please sign in again.')
    }

    const payload = await this.safeJsonParse<{ access_token?: string; token?: string }>(response, 'Failed to parse login response')
    const nextToken = payload.access_token ?? payload.token

    if (!nextToken) {
      throw new Error('The Mealie authentication response did not include a valid token.')
    }

    this.token = nextToken
    return nextToken
  }

  async getCurrentUser(): Promise<{ username?: string; first_name?: string; last_name?: string }> {
    const response = await fetch(`${this.baseUrl}/api/users/self`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Unable to load the current Mealie user profile.')
    }

    return await this.safeJsonParse<{ username?: string; first_name?: string; last_name?: string }>(response, 'Failed to parse user profile')
  }

  async getHealth(): Promise<{ ok: boolean; message: string }> {
    const response = await fetch(`${this.baseUrl}/api/app/about`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Unable to reach the Mealie server.')
    }

    return { ok: true, message: 'Connected' }
  }

  async testConnection(): Promise<{ ok: boolean; message: string; isCorsError?: boolean }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/app/about`, {
        method: 'GET',
        credentials: 'include',
      })

      if (!response.ok) {
        return {
          ok: false,
          message: `Server returned status ${response.status}. Verify the server URL is correct and the server is running.`,
          isCorsError: false,
        }
      }

      return { ok: true, message: 'Server connection successful!' }
    } catch (err) {
      // Check if this is likely a CORS error
      const isCorsError =
        err instanceof TypeError && (err.message.includes('Failed to fetch') || err.message.includes('CORS'))

      if (isCorsError) {
        return {
          ok: false,
          message: `CORS Error: Your browser blocked the connection to the Mealie server. This is a security restriction. You have two options: 1) Use the included CORS proxy (recommended for self-hosted servers) - run 'node cors-proxy.js' in the app directory and connect to http://localhost:3001 instead. 2) Configure CORS headers on your Mealie server.`,
          isCorsError: true,
        }
      }

      if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
        return {
          ok: false,
          message: `Cannot reach the Mealie server. Verify: 1) The server URL is correct (http://192.168.1.100:8080 or similar) 2) Your browser can access it 3) The Mealie server is running 4) Check your network connection.`,
          isCorsError: false,
        }
      }

      return {
        ok: false,
        message: `Connection error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        isCorsError: false,
      }
    }
  }

  async getRecipes(filters: RecipeQueryFilters = {}): Promise<MealieRecipeSummary[]> {
    const query = this.buildQueryString({
      search: filters.search,
      categories: filters.categories,
      tags: filters.tags,
      page: filters.page ?? 1,
      perPage: filters.perPage ?? 50,
    })

    const response = await fetch(`${this.baseUrl}/api/recipes${query}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load recipes from Mealie.')
    }

    const data = await this.safeJsonParse<
      | MealieRecipeSummary[]
      | { items: MealieRecipeSummary[]; total: number; page: number }
    >(response, 'Failed to parse recipes')

    // Handle both array and paginated response formats
    const items = Array.isArray(data) ? data : data.items ?? []
    return this.applyClientSideRecipeFilters(items, filters)
  }

  /** Filters that Mealie's list endpoint does not support server-side across
   * versions (ingredients-on-hand and time caps) are applied here so callers
   * can rely on a single filtered result set. */
  private applyClientSideRecipeFilters(
    recipes: MealieRecipeSummary[],
    filters: RecipeQueryFilters,
  ): MealieRecipeSummary[] {
    let result = recipes

    if (filters.maxPrepTime !== undefined) {
      result = result.filter((recipe) => {
        const minutes = parseMealieTimeToMinutes(recipe.prepTime)
        return minutes === undefined || minutes <= filters.maxPrepTime!
      })
    }

    if (filters.maxCookTime !== undefined) {
      result = result.filter((recipe) => {
        const minutes = parseMealieTimeToMinutes(recipe.cookTime)
        return minutes === undefined || minutes <= filters.maxCookTime!
      })
    }

    return result
  }

  /**
   * Fetches every recipe matching the server-supported filters (search,
   * categories, tags), paging through the full collection. Used by Dinner
   * Roulette so the random pick happens over the complete matching set
   * rather than a single page.
   */
  async getAllRecipes(filters: RecipeQueryFilters = {}): Promise<MealieRecipeSummary[]> {
    const perPage = 100
    let page = 1
    let all: MealieRecipeSummary[] = []

    // Safety cap to avoid runaway pagination against a misbehaving server.
    for (let iterations = 0; iterations < 200; iterations += 1) {
      const batch = await this.getRecipes({ ...filters, page, perPage })
      all = all.concat(batch)
      if (batch.length < perPage) break
      page += 1
    }

    return all
  }

  async getRecipe(slug: string): Promise<MealieRecipeDetail> {
    const response = await fetch(`${this.baseUrl}/api/recipes/${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load that recipe from Mealie.')
    }

    const data = await this.safeJsonParse<Record<string, unknown>>(response, 'Failed to parse recipe')
    return this.normalizeRecipeDetail(data)
  }

  async loadRecipeImage(imageUrl: string): Promise<string> {
    const response = await fetch(imageUrl, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load recipe image.')
    }

    return URL.createObjectURL(await response.blob())
  }

  resolveRecipeImage(recipe: Pick<MealieRecipeSummary, 'id' | 'image'>): string | undefined {
    const rawImage = recipe.image as unknown
    if (typeof rawImage === 'string' && rawImage.startsWith('http')) return rawImage
    if (!rawImage) return undefined

    return `${this.baseUrl}/api/media/recipes/${encodeURIComponent(recipe.id)}/images/original.webp`
  }

  async importRecipeFromUrl(url: string): Promise<MealieRecipeDetail> {
    const response = await fetch(`${this.baseUrl}/api/recipes/create/url?url=${encodeURIComponent(url)}`, {
      method: 'POST',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error(`Failed to import recipe from URL (server returned ${response.status}).`)
    }

    const data = await this.safeJsonParse<Record<string, unknown>>(response, 'Failed to parse imported recipe')
    return this.normalizeRecipeDetail(data)
  }

  async getCategories(): Promise<MealieCategory[]> {
    const response = await fetch(`${this.baseUrl}/api/organizers/categories`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load Mealie categories.')
    }

    const data = await this.safeJsonParse<
      | MealieCategory[]
      | { items: MealieCategory[]; total: number }
    >(response, 'Failed to parse categories')
    
    if (Array.isArray(data)) {
      return data
    }
    
    return data.items ?? []
  }

  async getTags(): Promise<MealieTag[]> {
    const response = await fetch(`${this.baseUrl}/api/organizers/tags`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load Mealie tags.')
    }

    const data = await this.safeJsonParse<
      | MealieTag[]
      | { items: MealieTag[]; total: number }
    >(response, 'Failed to parse tags')
    
    if (Array.isArray(data)) {
      return data
    }
    
    return data.items ?? []
  }

  async getShoppingLists(): Promise<MealieShoppingList[]> {
    const response = await fetch(`${this.baseUrl}/api/households/shopping/lists`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load shopping lists.')
    }

    const data = await this.safeJsonParse<
      | MealieShoppingListResponse[]
      | { items: MealieShoppingListResponse[]; total: number }
    >(response, 'Failed to parse shopping lists')

    const lists = Array.isArray(data) ? data : data.items ?? []
    return lists.map((list) => this.normalizeShoppingList(list))
  }

  async getShoppingList(id: string): Promise<MealieShoppingList> {
    const response = await fetch(`${this.baseUrl}/api/households/shopping/lists/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load that shopping list.')
    }

    const data = await this.safeJsonParse<MealieShoppingListResponse>(response, 'Failed to parse shopping list')
    return this.normalizeShoppingList(data)
  }

  async createShoppingList(name: string): Promise<MealieShoppingList> {
    const response = await fetch(`${this.baseUrl}/api/households/shopping/lists`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name }),
    })

    if (!response.ok) {
      throw new Error('Failed to create a new shopping list.')
    }

    const data = await this.safeJsonParse<MealieShoppingListResponse>(response, 'Failed to parse created shopping list')
    return this.normalizeShoppingList(data)
  }

  async deleteShoppingList(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/households/shopping/lists/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to delete that shopping list.')
    }
  }

  async addToShoppingList(listId: string, item: { quantity?: number | string; unit?: string; food?: string; note?: string }): Promise<MealieShoppingList> {
    const display = item.food
      ? `${item.quantity ?? ''} ${item.unit ?? ''} ${item.food}${item.note ? ` (${item.note})` : ''}`.replace(/\s+/g, ' ').trim()
      : item.note ?? ''

    const response = await fetch(`${this.baseUrl}/api/households/shopping/items`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        shoppingListId: listId,
        quantity: typeof item.quantity === 'string' ? Number.parseFloat(item.quantity) : item.quantity ?? 1,
        unit: item.unit ? { name: item.unit } : null,
        food: item.food ? { name: item.food } : null,
        note: item.note ?? null,
        display,
      }),
    })

    if (!response.ok) {
      throw new Error('Failed to add item to shopping list.')
    }

    await this.safeJsonParse<unknown>(response, 'Failed to parse added shopping list item')
    return await this.getShoppingList(listId)
  }

  async removeFromShoppingList(_listId: string, itemId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/households/shopping/items/${encodeURIComponent(itemId)}`,
      {
        method: 'DELETE',
        headers: this.headers(),
      },
    )

    if (!response.ok) {
      throw new Error('Failed to remove item from shopping list.')
    }
  }

  async removeAllFromShoppingList(listId: string, itemIds: string[]): Promise<MealieShoppingList> {
    await Promise.all(itemIds.map((itemId) => this.removeFromShoppingList(listId, itemId)))
    return await this.getShoppingList(listId)
  }

  async updateShoppingListItem(listId: string, itemId: string, updates: { checked?: boolean; quantity?: number | string; unit?: string }): Promise<MealieShoppingList> {
    const response = await fetch(
      `${this.baseUrl}/api/households/shopping/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ ...updates, shoppingListId: listId }),
      },
    )

    if (!response.ok) {
      throw new Error('Failed to update shopping list item.')
    }

    await this.safeJsonParse<unknown>(response, 'Failed to parse updated shopping list item')
    return await this.getShoppingList(listId)
  }

  /**
   * Adds the ingredients from a Mealie recipe to a shopping list using the
   * recipe-specific API endpoint. This is the most reliable path because the
   * server already knows the recipe's ingredient structure and preserves the
   * original quantities, units, and ingredient metadata.
   */
  async addRecipeIngredientsToShoppingList(
    listId: string,
    recipeId: string,
    recipeIncrementQuantity = 1,
  ): Promise<MealieShoppingList> {
    const response = await fetch(`${this.baseUrl}/api/households/shopping/lists/${encodeURIComponent(listId)}/recipe/${encodeURIComponent(recipeId)}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ recipeIncrementQuantity }),
    })

    if (!response.ok) {
      throw new Error('Failed to add recipe ingredients to shopping list.')
    }

    await this.safeJsonParse<unknown>(response, 'Failed to parse recipe shopping-list response')
    return await this.getShoppingList(listId)
  }

  private normalizeShoppingList(list: MealieShoppingListResponse): MealieShoppingList {
    return {
      ...list,
      items: list.items ?? list.listItems ?? [],
    }
  }

  async getMealPlans(startDate?: string, endDate?: string): Promise<MealieWeekPlan[]> {
    const query = this.buildQueryString({
      start_date: startDate,
      end_date: endDate,
    })

    const response = await fetch(`${this.baseUrl}/api/households/mealplans${query}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load meal plans.')
    }

    const data = await this.safeJsonParse<
      | MealieWeekPlan[]
      | { items: MealieWeekPlan[]; total: number }
    >(response, 'Failed to parse meal plans')
    
    if (Array.isArray(data)) {
      return data
    }
    
    return data.items ?? []
  }

  async getMealPlan(id: string): Promise<MealieWeekPlan> {
    const response = await fetch(`${this.baseUrl}/api/households/mealplans/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load that meal plan.')
    }

    return await this.safeJsonParse<MealieWeekPlan>(response, 'Failed to parse meal plan')
  }

  async createMealPlanEntry(entry: {
    date: string
    entryType: string
    title?: string
    text?: string
    recipeId?: string
  }): Promise<MealieWeekPlan> {
    const response = await fetch(`${this.baseUrl}/api/households/mealplans`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(entry),
    })

    if (!response.ok) {
      throw new Error('Failed to create meal plan entry.')
    }

    return await this.safeJsonParse<MealieWeekPlan>(response, 'Failed to parse created meal plan entry')
  }

  async deleteMealPlanEntry(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/households/mealplans/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to delete meal plan entry.')
    }
  }
}

/** A single meal-plan slot: one date + meal type, grouping every recipe
 * (i.e. every underlying Mealie meal-plan entry) that belongs to it. Mealie
 * itself only models one recipe per entry, so "multiple recipes in one
 * slot" is represented here as multiple entries sharing the same date and
 * entryType. */
export interface MealPlanSlot {
  date: string
  entryType: PlannableMealType | string
  entries: MealieWeekPlan[]
}

/** Groups a flat list of Mealie meal-plan entries into date + meal-type
 * slots so the UI can show every recipe belonging to the same slot together. */
export function groupMealPlanEntriesIntoSlots(entries: MealieWeekPlan[]): MealPlanSlot[] {
  const slots = new Map<string, MealPlanSlot>()

  for (const entry of entries) {
    const date = entry.date ?? 'unknown'
    const entryType = (entry.entryType ?? 'dinner').toLowerCase()
    const key = `${date}::${entryType}`

    const existing = slots.get(key)
    if (existing) {
      existing.entries.push(entry)
    } else {
      slots.set(key, { date, entryType, entries: [entry] })
    }
  }

  return Array.from(slots.values()).sort((a, b) => a.date.localeCompare(b.date))
}
