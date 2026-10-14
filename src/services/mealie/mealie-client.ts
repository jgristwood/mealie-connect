import type {
  MealieCategory,
  MealieFood,
  MealieRecipeDetail,
  MealieRecipeSummary,
  MealieShoppingList,
  MealieShoppingListItem,
  MealieWeekPlan,
  MealieTag,
  PlannableMealType,
} from '../../types/mealie'
import { settleWithConcurrency } from '../../lib/concurrency'
import { bumpSyncRevision, getSyncStatus, updateSyncStatus } from '../../lib/sync-status'
import { OfflineStore, isTempId, newTempId, offlineNamespace, type MealPlanEntryInput, type OutboxOp } from './offline-store'

export type { MealPlanEntryInput } from './offline-store'

const REQUEST_TIMEOUT_MS = 20_000
/** Importing makes Mealie download and parse the page first. */
const IMPORT_TIMEOUT_MS = 120_000
/** Statuses a reverse proxy returns when Mealie itself is down. */
const UNREACHABLE_STATUSES = new Set([502, 503, 504])
const OFFLINE_SYNC_CONCURRENCY = 4
export const OFFLINE_NOT_SAVED_MESSAGE = "You're offline, and this hasn't been saved on this device yet."

/** The Mealie server couldn't be reached (no network, server down, or no
 * answer in time). Reads fall back to the device copy when this happens. */
export class OfflineError extends Error {
  constructor(message = "Can't reach your Mealie server right now. Check your connection and try again.") {
    super(message)
    this.name = 'OfflineError'
  }
}

export interface MealieClientOptions {
  baseUrl: string
  token?: string
}

export interface RecipeQueryFilters {
  search?: string
  categories?: string[]
  tags?: string[]
  /** Mealie food IDs; matches recipes that use any of them. */
  foods?: string[]
  /** Maximum prep time, in minutes. Applied client-side since Mealie's list
   * endpoint does not expose a time-range filter across versions. */
  maxPrepTime?: number
  /** Maximum cook time, in minutes. Applied client-side (see above). */
  maxCookTime?: number
  page?: number
  perPage?: number
  /** Mealie column to sort by, e.g. "created_at" or "name". */
  orderBy?: string
  orderDirection?: 'asc' | 'desc'
}

export type RecipeImageSize = 'original' | 'min-original' | 'tiny-original'

/** Recipe fields that can be changed after import, in Mealie's field names. */
export interface RecipeChanges {
  name?: string
  recipeCategory?: MealieCategory[]
  tags?: MealieTag[]
  recipeServings?: number
}

type MealieShoppingListResponse = MealieShoppingList & { listItems?: MealieShoppingList['items'] }

const TIME_UNIT_MINUTES: Array<[RegExp, number]> = [
  [/^d(ays?)?$/i, 24 * 60],
  [/^h(rs?|ours?)?$/i, 60],
  [/^m(ins?|inutes?)?$/i, 1],
]

/** Parses a Mealie time value into whole minutes. Mealie stores prep and cook
 * times as free text, so this accepts a number of minutes, an ISO 8601
 * duration such as "PT20M", or text like "1 hour 30 minutes" or "1h 15m". */
export function parseMealieTimeToMinutes(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = value.trim()

  const isoMatch = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/i.exec(text)
  if (isoMatch) {
    const days = Number(isoMatch[1] ?? 0)
    const hours = Number(isoMatch[2] ?? 0)
    const minutes = Number(isoMatch[3] ?? 0)
    return days * 24 * 60 + hours * 60 + minutes
  }

  let total = 0
  let matchedUnit = false
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-z]+)/gi)) {
    const amount = Number.parseFloat((match[1] ?? '').replace(',', '.'))
    const unit = TIME_UNIT_MINUTES.find(([pattern]) => pattern.test(match[2] ?? ''))
    if (!unit || !Number.isFinite(amount)) continue
    total += amount * unit[1]
    matchedUnit = true
  }
  if (matchedUnit) return Math.round(total)

  const numeric = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN
  return Number.isNaN(numeric) ? undefined : numeric
}

/** True when a recipe's time is known and at most `maxMinutes`. */
export function isWithinTime(value: number | string | undefined, maxMinutes: number | undefined): boolean {
  if (maxMinutes === undefined) return true
  const minutes = parseMealieTimeToMinutes(value)
  return minutes !== undefined && minutes <= maxMinutes
}

/** Formats a Mealie time value for display. Numeric and ISO 8601 values are
 * rendered as "1 h 30 min"; free-form strings (e.g. "1 hour 30 minutes") are
 * returned as Mealie stored them. */
export function formatMealieTime(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const isNumeric = typeof value === 'number' || /^\d+$/.test(value.trim()) || /^P(?:\d+D)?T?(?:\d+H)?(?:\d+M)?$/i.test(value.trim())
  if (!isNumeric) return String(value).trim()
  const minutes = parseMealieTimeToMinutes(value)
  if (minutes === undefined) return String(value).trim()
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) return `${remainder} min`
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`
}

/** Mealie has stored servings as `recipeServings` (v2), `recipeYieldQuantity`,
 * or a free-text `recipeYield` such as "4 servings". Copies the first usable
 * number onto `servings`. */
export function normalizeRecipeServings<T extends Record<string, unknown>>(recipe: T): T & { servings?: number } {
  const candidates = [recipe.servings, recipe.recipeServings, recipe.recipeYieldQuantity, recipe.recipeYield]
  for (const candidate of candidates) {
    const value = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number.parseFloat(candidate) : Number.NaN
    if (Number.isFinite(value) && value > 0) return { ...recipe, servings: value }
  }
  return { ...recipe, servings: undefined }
}

export class MealieClient {
  baseUrl: string
  token?: string
  private offlineStore?: OfflineStore

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
    const rawNotes = (value as { notes?: unknown }).notes
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

    const notes = Array.isArray(rawNotes)
      ? (rawNotes as Array<{ title?: unknown; text?: unknown }>)
          .map((note) => ({
            title: typeof note?.title === 'string' ? note.title : undefined,
            text: typeof note?.text === 'string' ? note.text : undefined,
          }))
          .filter((note) => note.title || note.text)
      : typeof rawNotes === 'string' && rawNotes.trim()
        ? [{ text: rawNotes }]
        : []

    return {
      ...(normalizeRecipeServings(value) as unknown as MealieRecipeDetail),
      image,
      ingredients,
      instructions,
      notes,
      categories: recipe.categories ?? recipe.recipeCategory,
      totalTime: recipe.totalTime,
      prepTime: recipe.prepTime,
      cookTime: recipe.cookTime,
      url: recipe.url ?? recipe.orgURL,
    }
  }

  /** Sends a request to Mealie. Any failure to reach the server (no
   * network, server down, a proxy reporting the server unreachable, or no
   * answer within `timeoutMs`) becomes an OfflineError, so callers can fall
   * back to data saved on the device. */
  private async send(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      updateSyncStatus({ offline: true })
      throw new OfflineError()
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined
    try {
      const response = await fetch(url, controller ? { ...init, signal: controller.signal } : init)
      if (UNREACHABLE_STATUSES.has(response.status)) {
        updateSyncStatus({ offline: true })
        throw new OfflineError()
      }
      updateSyncStatus({ offline: false })
      return response
    } catch (error) {
      if (error instanceof OfflineError) throw error
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
        updateSyncStatus({ offline: true })
        throw new OfflineError()
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** The device copy of this account's data. */
  get offline(): OfflineStore {
    const namespace = offlineNamespace(this.baseUrl, this.token)
    if (this.offlineStore?.namespace !== namespace) this.offlineStore = new OfflineStore(namespace)
    return this.offlineStore
  }

  /** Reads from Mealie and saves the result on the device; when Mealie
   * can't be reached, answers from the device copy instead. */
  private async readThrough<T>(online: () => Promise<T>, save: (value: T) => Promise<void>, offline: () => Promise<T | undefined>): Promise<T> {
    await this.flushIfPending()
    try {
      const value = await online()
      await save(value).catch(() => undefined)
      return value
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      const cached = await offline().catch(() => undefined)
      if (cached === undefined) throw new OfflineError(OFFLINE_NOT_SAVED_MESSAGE)
      return cached
    }
  }

  async loginWithPassword(username: string, password: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
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

  /** Creates a long-lived Mealie API token for the signed-in user. Password
   * logins return short-lived session tokens (48h by default), so the app
   * swaps them for an API token to avoid silent logouts. */
  async createApiToken(name: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/users/api-tokens`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name }),
    })

    if (!response.ok) {
      throw new Error('Unable to create a Mealie API token.')
    }

    const payload = await this.safeJsonParse<{ token?: string }>(response, 'Failed to parse API token response')
    if (!payload.token) {
      throw new Error('The Mealie API token response did not include a token.')
    }
    return payload.token
  }

  async getCurrentUser(): Promise<{ username?: string; fullName?: string; full_name?: string; first_name?: string; last_name?: string }> {
    const response = await this.send(`${this.baseUrl}/api/users/self`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Mealie authentication failed. Please sign in again.')
      }
      throw new Error('Unable to load the current Mealie user profile.')
    }

    return await this.safeJsonParse<{ username?: string; fullName?: string; full_name?: string; first_name?: string; last_name?: string }>(response, 'Failed to parse user profile')
  }

  async getHealth(): Promise<{ ok: boolean; message: string }> {
    const response = await this.send(`${this.baseUrl}/api/app/about`, {
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
          message: 'Your browser could not connect to the Mealie server. Check the URL is correct and the server is online. If it is, the server is most likely blocking this website (a CORS setting). See the options below.',
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

  // Recipes ---------------------------------------------------------------

  async getRecipes(filters: RecipeQueryFilters = {}): Promise<MealieRecipeSummary[]> {
    const items = await this.readThrough(
      () => this.fetchRecipePage(filters),
      (recipes) => this.offline.mergeRecipeSummaries(recipes),
      () => this.searchSavedRecipes(filters),
    )
    return this.applyClientSideRecipeFilters(items, filters)
  }

  private async fetchRecipePage(filters: RecipeQueryFilters): Promise<MealieRecipeSummary[]> {
    const query = this.buildQueryString({
      search: filters.search,
      categories: filters.categories,
      tags: filters.tags,
      foods: filters.foods,
      page: filters.page ?? 1,
      perPage: filters.perPage ?? 50,
      orderBy: filters.orderBy,
      orderDirection: filters.orderDirection,
    })

    const response = await this.send(`${this.baseUrl}/api/recipes${query}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Mealie authentication failed. Please sign in again.')
      }
      throw new Error('Failed to load recipes from Mealie.')
    }

    const data = await this.safeJsonParse<
      | MealieRecipeSummary[]
      | { items: MealieRecipeSummary[]; total: number; page: number }
    >(response, 'Failed to parse recipes')

    // Handle both array and paginated response formats
    return (Array.isArray(data) ? data : data.items ?? [])
      .map((item) => normalizeRecipeServings(item as unknown as Record<string, unknown>) as unknown as MealieRecipeSummary)
  }

  /** Answers a recipe query from the recipes saved on this device. Text
   * search also looks through the ingredients of saved recipe details. */
  private async searchSavedRecipes(filters: RecipeQueryFilters): Promise<MealieRecipeSummary[] | undefined> {
    const index = await this.offline.getRecipeIndex()
    let recipes = Object.values(index)
    if (recipes.length === 0) return undefined

    const search = filters.search?.trim().toLowerCase()
    const needsDetails = Boolean(search) || (filters.foods?.length ?? 0) > 0
    const details = needsDetails ? await this.offline.getRecipeDetails(recipes.map((recipe) => recipe.id)) : new Map<string, MealieRecipeDetail>()

    if (search) {
      recipes = recipes.filter((recipe) => {
        const ingredients = (details.get(recipe.id)?.ingredients ?? []).map((ingredient) => `${ingredient.food ?? ''} ${ingredient.note ?? ''} ${ingredient.display ?? ''}`)
        return [recipe.name, recipe.description ?? '', ...ingredients].join(' ').toLowerCase().includes(search)
      })
    }
    const organizerIds = (recipe: MealieRecipeSummary, field: 'categories' | 'tags') => {
      const values = field === 'tags' ? recipe.tags : recipe.categories ?? (recipe as { recipeCategory?: MealieCategory[] }).recipeCategory
      return (values ?? []).map((value) => value.id)
    }
    if (filters.categories?.length) recipes = recipes.filter((recipe) => organizerIds(recipe, 'categories').some((id) => filters.categories?.includes(id)))
    if (filters.tags?.length) recipes = recipes.filter((recipe) => organizerIds(recipe, 'tags').some((id) => filters.tags?.includes(id)))
    if (filters.foods?.length) {
      recipes = recipes.filter((recipe) => {
        const raw = (details.get(recipe.id) as { recipeIngredient?: Array<{ food?: { id?: string } | null }> } | undefined)?.recipeIngredient ?? []
        return raw.some((ingredient) => ingredient.food?.id && filters.foods?.includes(ingredient.food.id))
      })
    }

    if (filters.orderBy === 'created_at') {
      const created = (recipe: MealieRecipeSummary) => String((recipe as { createdAt?: string; dateAdded?: string }).createdAt ?? (recipe as { dateAdded?: string }).dateAdded ?? '')
      recipes.sort((a, b) => created(a).localeCompare(created(b)) * (filters.orderDirection === 'desc' ? -1 : 1))
    } else {
      recipes.sort((a, b) => a.name.localeCompare(b.name))
    }

    const perPage = filters.perPage ?? 50
    const start = ((filters.page ?? 1) - 1) * perPage
    return recipes.slice(start, start + perPage)
  }

  /** Filters that Mealie's list endpoint does not support server-side across
   * versions (time caps) are applied here so callers can rely on a single
   * filtered result set. */
  private applyClientSideRecipeFilters(
    recipes: MealieRecipeSummary[],
    filters: RecipeQueryFilters,
  ): MealieRecipeSummary[] {
    // A recipe with no time recorded can't be shown to fit under a limit, so
    // it is left out once a limit is set.
    return recipes.filter((recipe) =>
      isWithinTime(recipe.prepTime, filters.maxPrepTime) && isWithinTime(recipe.cookTime, filters.maxCookTime))
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
      const batch = await this.getRecipes({ ...filters, page, perPage, maxPrepTime: undefined, maxCookTime: undefined })
      all = all.concat(batch)
      if (batch.length < perPage) break
      page += 1
    }

    return this.applyClientSideRecipeFilters(all, filters)
  }

  async getRecipe(slug: string): Promise<MealieRecipeDetail> {
    return await this.readThrough(
      () => this.fetchRecipe(slug),
      (recipe) => this.offline.saveRecipeDetail(recipe),
      () => this.offline.getRecipeDetail(slug),
    )
  }

  private async fetchRecipe(slug: string): Promise<MealieRecipeDetail> {
    const response = await this.send(`${this.baseUrl}/api/recipes/${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load that recipe from Mealie.')
    }

    const data = await this.safeJsonParse<Record<string, unknown>>(response, 'Failed to parse recipe')
    return this.normalizeRecipeDetail(data)
  }

  /** Loads a recipe image as an object URL (the caller revokes it). Images
   * are kept on the device so recipes still have pictures offline. */
  async loadRecipeImage(imageUrl: string): Promise<string> {
    try {
      const blob = await this.fetchImage(imageUrl)
      await this.offline.saveImage(imageUrl, blob).catch(() => undefined)
      return URL.createObjectURL(blob)
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      // Offline, a saved thumbnail is better than nothing for a full-size image.
      const fallbackUrl = imageUrl.replace(/\/original\.webp(\?.*)?$/, '/min-original.webp$1')
      const cached = (await this.offline.getImage(imageUrl)) ?? (fallbackUrl !== imageUrl ? await this.offline.getImage(fallbackUrl) : undefined)
      if (!cached) throw error
      return URL.createObjectURL(cached)
    }
  }

  private async fetchImage(imageUrl: string): Promise<Blob> {
    const response = await this.send(imageUrl, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load recipe image.')
    }

    return await response.blob()
  }

  /** Resolves a recipe's image URL. Use 'min-original' for cards and
   * thumbnails; it is a fraction of the size of the full original. */
  resolveRecipeImage(recipe: Pick<MealieRecipeSummary, 'id' | 'image'>, size: RecipeImageSize = 'original'): string | undefined {
    const rawImage = recipe.image as unknown
    if (typeof rawImage === 'string' && rawImage.startsWith('http')) {
      return size === 'original' ? rawImage : rawImage.replace(/\/original\.webp(\?.*)?$/, `/${size}.webp$1`)
    }
    if (!rawImage) return undefined

    return `${this.baseUrl}/api/media/recipes/${encodeURIComponent(recipe.id)}/images/${size}.webp`
  }

  async importRecipeFromUrl(url: string): Promise<MealieRecipeDetail> {
    const endpoint = `${this.baseUrl}/api/recipes/create/url`
    const payload = {
      url,
      includeTags: true,
      includeCategories: true,
    }

    if (import.meta.env.DEV) {
      console.debug('[Mealie import]', {
        method: 'POST',
        url: endpoint,
        bodyKeys: Object.keys(payload),
      })
    }

    // Mealie downloads and parses the page while we wait, which can be slow.
    const response = await this.send(endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    }, IMPORT_TIMEOUT_MS)

    const responseText = await response.text()

    if (import.meta.env.DEV) {
      console.debug('[Mealie import response]', {
        status: response.status,
        body: this.summarizeResponseBody(responseText),
      })
    }

    if (!response.ok) {
      throw new Error(this.formatRecipeImportError(response.status, responseText))
    }

    const parsed = this.parseRecipeImportResponse(responseText)

    if (typeof parsed === 'string') {
      return await this.getRecipe(parsed)
    }

    const recipe = this.normalizeRecipeDetail(parsed)
    await this.offline.saveRecipeDetail(recipe).catch(() => undefined)
    return recipe
  }

  private parseRecipeImportResponse(responseText: string): string | Record<string, unknown> {
    if (!responseText.trim()) {
      throw new Error('Failed to parse imported recipe')
    }

    try {
      return JSON.parse(responseText) as string | Record<string, unknown>
    } catch {
      return responseText
    }
  }

  private summarizeResponseBody(responseText: string): unknown {
    try {
      return JSON.parse(responseText) as unknown
    } catch {
      return responseText.slice(0, 400)
    }
  }

  private formatRecipeImportError(status: number, responseText: string): string {
    const parsed = this.summarizeResponseBody(responseText)

    const validationMessage = this.extractMeaningfulErrorMessage(parsed)
    if (status === 422 && validationMessage) {
      return `Recipe import failed: ${validationMessage}`
    }

    if (status === 401) {
      return 'Mealie authentication failed. Please sign in again.'
    }

    if (status === 403) {
      return 'Mealie rejected the recipe import: you do not have permission to import recipes.'
    }

    if (status === 422) {
      return 'Mealie rejected the recipe import. Please enter a valid recipe URL.'
    }

    if (status >= 500 && validationMessage) {
      return `Mealie could not extract a recipe from this website: ${validationMessage}`
    }

    if (status >= 500) {
      return 'Mealie could not extract a recipe from this website.'
    }

    return `Recipe import failed (server returned ${status}).`
  }

  private extractMeaningfulErrorMessage(payload: unknown): string | undefined {
    if (typeof payload === 'string' && payload.trim()) {
      return payload.trim()
    }

    if (!payload || typeof payload !== 'object') return undefined

    const detail = (payload as { detail?: unknown }).detail
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          if (!item || typeof item !== 'object') return undefined
          const message = (item as { msg?: unknown }).msg
          return typeof message === 'string' ? message : undefined
        })
        .filter((value): value is string => Boolean(value))

      if (messages.length > 0) {
        return messages.join('; ')
      }
    }

    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }

    return undefined
  }

  /** Updates only the given recipe fields. Mealie regenerates the slug when
   * the name changes, so use the slug on the returned recipe afterwards. */
  async updateRecipe(slug: string, changes: RecipeChanges): Promise<MealieRecipeDetail> {
    const response = await this.send(`${this.baseUrl}/api/recipes/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(changes),
    })

    if (!response.ok) {
      if (response.status === 401) throw new Error('Mealie authentication failed. Please sign in again.')
      if (response.status === 403) throw new Error('Mealie did not allow changes to this recipe.')
      const message = this.extractMeaningfulErrorMessage(this.summarizeResponseBody(await response.text()))
      throw new Error(message ? `Could not save the recipe: ${message}` : 'Could not save the recipe.')
    }

    const data = await this.safeJsonParse<Record<string, unknown>>(response, 'Failed to parse saved recipe')
    const recipe = this.normalizeRecipeDetail(data)
    if (recipe.slug !== slug) await this.offline.removeRecipe(slug).catch(() => undefined)
    await this.offline.saveRecipeDetail(recipe).catch(() => undefined)
    return recipe
  }

  async deleteRecipe(slug: string): Promise<void> {
    const response = await this.send(`${this.baseUrl}/api/recipes/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Could not delete that recipe.')
    }
    await this.offline.removeRecipe(slug).catch(() => undefined)
  }

  // Categories, tags and foods --------------------------------------------

  async createCategory(name: string): Promise<MealieCategory> {
    return this.createOrganizer<MealieCategory>('categories', name)
  }

  async createTag(name: string): Promise<MealieTag> {
    return this.createOrganizer<MealieTag>('tags', name)
  }

  private async createOrganizer<T>(kind: 'categories' | 'tags', name: string): Promise<T> {
    const response = await this.send(`${this.baseUrl}/api/organizers/${kind}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name }),
    })

    if (!response.ok) {
      throw new Error(`Could not create the ${kind === 'tags' ? 'tag' : 'category'} "${name}".`)
    }

    return await this.safeJsonParse<T>(response, `Failed to parse created ${kind}`)
  }

  async getCategories(): Promise<MealieCategory[]> {
    return await this.readThrough(
      () => this.fetchOrganizers<MealieCategory>('categories'),
      (categories) => this.offline.saveCategories(categories),
      () => this.offline.getCategories(),
    )
  }

  async getTags(): Promise<MealieTag[]> {
    return await this.readThrough(
      () => this.fetchOrganizers<MealieTag>('tags'),
      (tags) => this.offline.saveTags(tags),
      () => this.offline.getTags(),
    )
  }

  private async fetchOrganizers<T>(kind: 'categories' | 'tags'): Promise<T[]> {
    const response = await this.send(`${this.baseUrl}/api/organizers/${kind}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error(kind === 'tags' ? 'Failed to load Mealie tags.' : 'Failed to load Mealie categories.')
    }

    const data = await this.safeJsonParse<T[] | { items: T[]; total: number }>(response, `Failed to parse ${kind}`)
    return Array.isArray(data) ? data : data.items ?? []
  }

  /** Searches Mealie's food database (the parsed ingredient names). */
  async getFoods(search: string): Promise<MealieFood[]> {
    const query = this.buildQueryString({ search, page: 1, perPage: 100 })
    const response = await this.send(`${this.baseUrl}/api/foods${query}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load foods from Mealie.')
    }

    const data = await this.safeJsonParse<MealieFood[] | { items: MealieFood[] }>(response, 'Failed to parse foods')
    return Array.isArray(data) ? data : data.items ?? []
  }

  // Shopping lists --------------------------------------------------------

  async getShoppingLists(): Promise<MealieShoppingList[]> {
    return await this.readThrough(
      () => this.fetchShoppingLists(),
      (lists) => this.offline.saveShoppingLists(lists),
      () => this.offline.getShoppingLists(),
    )
  }

  private async fetchShoppingLists(): Promise<MealieShoppingList[]> {
    const response = await this.send(`${this.baseUrl}/api/households/shopping/lists`, {
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
    return await this.readThrough(
      () => this.fetchShoppingList(id),
      (list) => this.offline.saveShoppingList(list),
      () => this.offline.getShoppingList(id),
    )
  }

  private async fetchShoppingList(id: string): Promise<MealieShoppingList> {
    const response = await this.send(`${this.baseUrl}/api/households/shopping/lists/${encodeURIComponent(id)}`, {
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
    const response = await this.send(`${this.baseUrl}/api/households/shopping/lists`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name }),
    })

    if (!response.ok) {
      throw new Error('Failed to create a new shopping list.')
    }

    const data = await this.safeJsonParse<MealieShoppingListResponse>(response, 'Failed to parse created shopping list')
    const list = this.normalizeShoppingList(data)
    await this.offline.saveShoppingList(list).catch(() => undefined)
    return list
  }

  async deleteShoppingList(id: string): Promise<void> {
    const response = await this.send(`${this.baseUrl}/api/households/shopping/lists/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to delete that shopping list.')
    }
    await this.offline.removeShoppingList(id).catch(() => undefined)
  }

  async addToShoppingList(listId: string, item: { quantity?: number | string; unit?: string; food?: string; note?: string }): Promise<MealieShoppingList> {
    const display = item.food
      ? `${item.quantity ?? ''} ${item.unit ?? ''} ${item.food}${item.note ? ` (${item.note})` : ''}`.replace(/\s+/g, ' ').trim()
      : item.note ?? ''
    const body = {
      shoppingListId: listId,
      quantity: typeof item.quantity === 'string' ? Number.parseFloat(item.quantity) : item.quantity ?? 1,
      unit: item.unit ? { name: item.unit } : null,
      food: item.food ? { name: item.food } : null,
      note: item.note ?? null,
      display,
    }

    await this.flushIfPending()
    try {
      await this.postShoppingItem(body)
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      return await this.queueOffline(async (ops) => {
        const tempId = newTempId()
        const updated = await this.offline.updateListItemsLocked(listId, (items) => [
          ...items,
          { id: tempId, quantity: body.quantity, unit: body.unit ?? undefined, food: body.food ?? undefined, note: body.note ?? '', display, checked: false } as unknown as MealieShoppingListItem,
        ])
        if (!updated) throw new OfflineError(OFFLINE_NOT_SAVED_MESSAGE)
        ops.push({ id: newTempId(), kind: 'shopping-add', listId, tempId, body })
        return updated
      })
    }
    return await this.getShoppingList(listId)
  }

  /** Creates a shopping item and returns its new ID. Mealie answers with
   * the items it created or merged into. */
  private async postShoppingItem(body: Record<string, unknown>): Promise<string | undefined> {
    const response = await this.send(`${this.baseUrl}/api/households/shopping/items`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error('Failed to add item to shopping list.')
    }

    const data = await this.safeJsonParse<{ id?: string; createdItems?: Array<{ id?: string }>; updatedItems?: Array<{ id?: string }> }>(response, 'Failed to parse added shopping list item')
    return data.createdItems?.[0]?.id ?? data.updatedItems?.[0]?.id ?? data.id
  }

  async removeFromShoppingList(listId: string, itemId: string): Promise<void> {
    await this.flushIfPending()
    try {
      await this.deleteShoppingItem(itemId)
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      await this.queueOffline(async (ops, idMap) => {
        const id = idMap[itemId] ?? itemId
        if (isTempId(id)) {
          // Never reached Mealie: forget it instead of creating then deleting it.
          removeOps(ops, (op) => (op.kind === 'shopping-add' && op.tempId === id) || ('itemId' in op && op.itemId === id))
        } else {
          removeOps(ops, (op) => op.kind === 'shopping-update' && op.itemId === id)
          ops.push({ id: newTempId(), kind: 'shopping-remove', listId, itemId: id })
        }
        await this.offline.updateListItemsLocked(listId, (items) => items.filter((item) => item.id !== itemId && item.id !== id))
      })
    }
    await this.offline.lock(() => this.offline.updateListItemsLocked(listId, (items) => items.filter((item) => item.id !== itemId))).catch(() => undefined)
  }

  private async deleteShoppingItem(itemId: string): Promise<void> {
    const response = await this.send(
      `${this.baseUrl}/api/households/shopping/items/${encodeURIComponent(itemId)}`,
      {
        method: 'DELETE',
        headers: this.headers(),
      },
    )

    // Already gone (for example removed on another device) counts as done.
    if (!response.ok && response.status !== 404) {
      throw new Error('Failed to remove item from shopping list.')
    }
  }

  async removeAllFromShoppingList(listId: string, itemIds: string[]): Promise<MealieShoppingList> {
    await Promise.all(itemIds.map((itemId) => this.removeFromShoppingList(listId, itemId)))
    return await this.getShoppingList(listId)
  }

  /** Updates a shopping list item. Mealie's PUT replaces the whole item, so
   * the full existing item is sent with the updates merged on top; sending
   * only the changed fields would reset quantity, note, food, etc. */
  async updateShoppingListItem(listId: string, item: MealieShoppingListItem, updates: { checked?: boolean; quantity?: number | string; note?: string }): Promise<MealieShoppingList> {
    if (!item.id) {
      throw new Error('That shopping list item cannot be updated.')
    }
    const itemId = item.id
    await this.flushIfPending()
    const idMap = isTempId(itemId) ? await this.offline.getIdMap() : {}
    const realId = idMap[itemId] ?? itemId
    try {
      if (isTempId(realId)) throw new OfflineError()
      await this.putShoppingItem(listId, { ...item, ...updates, id: realId })
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      return await this.queueOffline(async (ops, currentIdMap) => {
        const id = currentIdMap[itemId] ?? itemId
        const pendingAdd = ops.find((op): op is Extract<OutboxOp, { kind: 'shopping-add' }> => op.kind === 'shopping-add' && op.tempId === id)
        const pendingUpdate = ops.find((op): op is Extract<OutboxOp, { kind: 'shopping-update' }> => op.kind === 'shopping-update' && op.itemId === id)
        if (pendingAdd) pendingAdd.body = { ...pendingAdd.body, ...updates }
        else if (pendingUpdate) pendingUpdate.item = { ...pendingUpdate.item, ...updates }
        else ops.push({ id: newTempId(), kind: 'shopping-update', listId, itemId: id, item: { ...item, ...updates, id } })
        const updated = await this.offline.updateListItemsLocked(listId, (items) => items.map((candidate) => {
          if (candidate.id !== itemId && candidate.id !== id) return candidate
          const next = { ...candidate, ...updates }
          return { ...next, display: shoppingItemDisplay(next) }
        }))
        if (!updated) throw new OfflineError(OFFLINE_NOT_SAVED_MESSAGE)
        return updated
      })
    }
    return await this.getShoppingList(listId)
  }

  private async putShoppingItem(listId: string, item: MealieShoppingListItem): Promise<void> {
    const response = await this.send(
      `${this.baseUrl}/api/households/shopping/items/${encodeURIComponent(item.id ?? '')}`,
      {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({ ...item, shoppingListId: listId }),
      },
    )

    if (!response.ok) {
      throw new Error('Failed to update shopping list item.')
    }

    await this.safeJsonParse<unknown>(response, 'Failed to parse updated shopping list item')
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
    await this.flushIfPending()
    const response = await this.send(`${this.baseUrl}/api/households/shopping/lists/${encodeURIComponent(listId)}/recipe/${encodeURIComponent(recipeId)}`, {
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

  // Meal plans ------------------------------------------------------------

  async getMealPlans(startDate?: string, endDate?: string): Promise<MealieWeekPlan[]> {
    return await this.readThrough(
      () => this.fetchMealPlans(startDate, endDate),
      (entries) => this.offline.saveMealPlans(entries, startDate, endDate),
      async () => ((await this.offline.hasMealPlans()) ? await this.offline.getMealPlans(startDate, endDate) : undefined),
    )
  }

  private async fetchMealPlans(startDate?: string, endDate?: string): Promise<MealieWeekPlan[]> {
    const query = this.buildQueryString({
      start_date: startDate,
      end_date: endDate,
      perPage: -1,
    })

    const response = await this.send(`${this.baseUrl}/api/households/mealplans${query}`, {
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
    const response = await this.send(`${this.baseUrl}/api/households/mealplans/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: this.headers(),
    })

    if (!response.ok) {
      throw new Error('Failed to load that meal plan.')
    }

    return await this.safeJsonParse<MealieWeekPlan>(response, 'Failed to parse meal plan')
  }

  async createMealPlanEntry(entry: MealPlanEntryInput): Promise<MealieWeekPlan> {
    await this.flushIfPending()
    try {
      const created = await this.postMealPlan(entry)
      await this.offline.upsertMealPlan(created).catch(() => undefined)
      return created
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      const recipe = entry.recipeId ? (await this.offline.getRecipeIndex())[entry.recipeId] : undefined
      return await this.queueOffline(async (ops) => {
        const tempId = newTempId()
        const placeholder: MealieWeekPlan = { id: tempId, date: entry.date, entryType: entry.entryType, title: entry.title, text: entry.text, recipeId: entry.recipeId, recipe }
        ops.push({ id: newTempId(), kind: 'mealplan-create', tempId, body: entry })
        await this.offline.updateMealPlansLocked((record) => { record[tempId] = placeholder })
        return placeholder
      })
    }
  }

  private async postMealPlan(entry: MealPlanEntryInput): Promise<MealieWeekPlan> {
    const response = await this.send(`${this.baseUrl}/api/households/mealplans`, {
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
    await this.flushIfPending()
    const idMap = isTempId(id) ? await this.offline.getIdMap() : {}
    try {
      const realId = idMap[id] ?? id
      if (isTempId(realId)) throw new OfflineError()
      await this.deleteMealPlan(realId)
      await this.offline.removeMealPlan(realId).catch(() => undefined)
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      await this.queueOffline(async (ops, currentIdMap) => {
        const realId = currentIdMap[id] ?? id
        if (isTempId(realId)) removeOps(ops, (op) => op.kind === 'mealplan-create' && op.tempId === realId)
        else ops.push({ id: newTempId(), kind: 'mealplan-delete', entryId: realId })
        await this.offline.updateMealPlansLocked((record) => { delete record[id]; delete record[realId] })
      })
    }
  }

  private async deleteMealPlan(id: string): Promise<void> {
    const response = await this.send(`${this.baseUrl}/api/households/mealplans/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })

    if (!response.ok && response.status !== 404) {
      throw new Error('Failed to delete meal plan entry.')
    }
  }

  /** Records that the recipe was cooked: updates Mealie's "last made" date and
   * adds an entry to the recipe's timeline, as Mealie's own "I made this" does. */
  async markRecipeMade(recipe: { id: string; slug: string }, subject: string, timestamp = new Date().toISOString()): Promise<void> {
    await this.flushIfPending()
    try {
      await this.postRecipeMade(recipe, subject, timestamp)
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      await this.queueOffline(async (ops) => { ops.push({ id: newTempId(), kind: 'recipe-made', recipe, subject, timestamp }) })
    }
  }

  private async postRecipeMade(recipe: { id: string; slug: string }, subject: string, timestamp: string): Promise<void> {
    const lastMadeResponse = await this.send(`${this.baseUrl}/api/recipes/${encodeURIComponent(recipe.slug)}/last-made`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify({ timestamp }),
    })

    if (!lastMadeResponse.ok) {
      throw new Error('Mealie could not record that you made this recipe.')
    }

    const timelineResponse = await this.send(`${this.baseUrl}/api/recipes/timeline/events`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ recipeId: recipe.id, subject, eventType: 'comment', timestamp }),
    })

    if (!timelineResponse.ok) {
      throw new Error('Saved the date, but Mealie could not add a timeline entry.')
    }
  }

  // Offline changes and sync ----------------------------------------------

  /** Adds a change to the outbox and applies it to the device copy. */
  private async queueOffline<T>(change: (ops: OutboxOp[], idMap: Record<string, string>) => Promise<T>): Promise<T> {
    const store = this.offline
    const { value, pending } = await store.lock(async () => {
      const ops = await store.getOutbox()
      const idMap = await store.getIdMap()
      const result = await change(ops, idMap)
      await store.setOutboxLocked(ops)
      return { value: result, pending: ops.length }
    })
    updateSyncStatus({ pending, offline: true })
    return value
  }

  /** Number of changes made offline that haven't reached Mealie yet. */
  async refreshPendingCount(): Promise<number> {
    const pending = (await this.offline.getOutbox()).length
    updateSyncStatus({ pending })
    return pending
  }

  /** Sends changes made offline to Mealie, oldest first. Stops (keeping the
   * rest) as soon as the server can't be reached. Returns how many were sent. */
  async flushIfPending(): Promise<number> {
    if (getSyncStatus().pending === 0) return 0
    const store = this.offline
    const running = flushes.get(store.namespace)
    if (running) return await running
    const run = this.flushOutbox(store)
    flushes.set(store.namespace, run)
    try {
      return await run
    } finally {
      flushes.delete(store.namespace)
    }
  }

  private async flushOutbox(store: OfflineStore): Promise<number> {
    let sent = 0
    let failed = 0
    if ((await store.getOutbox()).length === 0) { updateSyncStatus({ pending: 0 }); return 0 }
    updateSyncStatus({ syncing: true })
    try {
      for (;;) {
        // Each change is sent while holding the lock, so a change queued at
        // the same moment can't be lost or reordered.
        const step = await store.lock(async () => {
          const ops = await store.getOutbox()
          const op = ops[0]
          if (!op) return 'done' as const
          const idMap = await store.getIdMap()
          try {
            await this.replay(store, op, idMap)
            sent += 1
          } catch (error) {
            if (error instanceof OfflineError) return 'offline' as const
            // Mealie refused it (e.g. the item was deleted elsewhere); drop it
            // rather than retrying forever.
            failed += 1
          }
          ops.shift()
          await store.setOutboxLocked(ops)
          await store.setIdMapLocked(idMap)
          updateSyncStatus({ pending: ops.length })
          return 'next' as const
        })
        if (step !== 'next') break
      }
    } finally {
      updateSyncStatus({ syncing: false, ...(failed > 0 ? { failed: getSyncStatus().failed + failed } : {}) })
      if (sent > 0 || failed > 0) bumpSyncRevision()
    }
    return sent
  }

  private async replay(store: OfflineStore, op: OutboxOp, idMap: Record<string, string>): Promise<void> {
    const resolve = (id: string) => idMap[id] ?? id
    switch (op.kind) {
      case 'shopping-add': {
        const createdId = await this.postShoppingItem(op.body)
        if (!createdId) return
        idMap[op.tempId] = createdId
        await store.updateListItemsLocked(op.listId, (items) => items.map((item) => (item.id === op.tempId ? { ...item, id: createdId } : item)))
        return
      }
      case 'shopping-update':
        await this.putShoppingItem(op.listId, { ...op.item, id: resolve(op.itemId) })
        return
      case 'shopping-remove':
        await this.deleteShoppingItem(resolve(op.itemId))
        return
      case 'mealplan-create': {
        const created = await this.postMealPlan(op.body)
        idMap[op.tempId] = created.id
        await store.updateMealPlansLocked((record) => {
          const placeholder = record[op.tempId]
          delete record[op.tempId]
          record[created.id] = { ...created, recipe: created.recipe ?? placeholder?.recipe }
        })
        return
      }
      case 'mealplan-delete':
        await this.deleteMealPlan(resolve(op.entryId))
        return
      case 'recipe-made':
        await this.postRecipeMade(op.recipe, op.subject, op.timestamp)
        return
    }
  }

  /**
   * Saves what's needed to keep cooking offline: the recipe list,
   * categories, tags, every shopping list, and the meal plan from a week ago
   * to five weeks ahead with its recipes. With `allRecipes`, also saves every
   * recipe's ingredients, steps and thumbnail.
   */
  async syncForOffline(options: { allRecipes?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
    await this.refreshPendingCount()
    await this.flushIfPending()
    updateSyncStatus({ syncing: true })
    const store = this.offline
    try {
      const summaries: MealieRecipeSummary[] = []
      for (let page = 1; page <= 200; page += 1) {
        const batch = await this.fetchRecipePage({ page, perPage: 100 })
        summaries.push(...batch)
        if (batch.length < 100) break
      }
      await store.mergeRecipeSummaries(summaries, true)

      const [categories, tags, lists] = await Promise.all([
        this.fetchOrganizers<MealieCategory>('categories'),
        this.fetchOrganizers<MealieTag>('tags'),
        this.fetchShoppingLists(),
      ])
      await store.saveCategories(categories)
      await store.saveTags(tags)
      const fullLists = await Promise.all(lists.map((list) => this.fetchShoppingList(list.id)))
      await store.saveShoppingLists(fullLists)

      const today = new Date()
      const start = dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7))
      const end = dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 35))
      const entries = await this.fetchMealPlans(start, end)
      await store.saveMealPlans(entries, start, end)

      const plannedIds = new Set(entries.map((entry) => entry.recipe?.id ?? entry.recipeId).filter((id): id is string => Boolean(id)))
      const wanted = options.allRecipes ? summaries : summaries.filter((recipe) => plannedIds.has(recipe.id))
      const saved = await store.getRecipeDetails(wanted.map((recipe) => recipe.id))
      const stale = wanted.filter((recipe) => {
        const detail = saved.get(recipe.id)
        return !detail || recipeVersion(detail) !== recipeVersion(recipe)
      })

      let done = 0
      options.onProgress?.(0, stale.length)
      await settleWithConcurrency(stale, OFFLINE_SYNC_CONCURRENCY, async (recipe) => {
        try {
          await store.saveRecipeDetail(await this.fetchRecipe(recipe.slug || recipe.id))
          const thumbnail = this.resolveRecipeImage(recipe, 'min-original')
          if (thumbnail && !(await store.getImage(thumbnail))) await store.saveImage(thumbnail, await this.fetchImage(thumbnail))
        } finally {
          done += 1
          options.onProgress?.(done, stale.length)
        }
      })

      const now = new Date().toISOString()
      await store.updateMeta(options.allRecipes ? { lastSyncedAt: now, allRecipesSavedAt: now } : { lastSyncedAt: now })
      updateSyncStatus({ lastSyncedAt: now })
      bumpSyncRevision()
    } finally {
      updateSyncStatus({ syncing: false })
    }
  }
}

const flushes = new Map<string, Promise<number>>()

function removeOps(ops: OutboxOp[], matches: (op: OutboxOp) => boolean): void {
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    if (matches(ops[index] as OutboxOp)) ops.splice(index, 1)
  }
}

/** The text Mealie shows for a shopping item, rebuilt after an offline edit. */
function shoppingItemDisplay(item: MealieShoppingListItem): string {
  const name = (value: unknown) => (typeof value === 'string' ? value : (value as { name?: string } | null | undefined)?.name ?? '')
  const quantity = Number(item.quantity)
  return [quantity > 0 ? String(quantity) : '', name(item.unit), name(item.food), item.note ?? ''].filter(Boolean).join(' ').trim()
}

function recipeVersion(recipe: MealieRecipeSummary): string {
  const source = recipe as { dateUpdated?: string; updatedAt?: string; updateAt?: string }
  return source.dateUpdated ?? source.updatedAt ?? source.updateAt ?? ''
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
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
