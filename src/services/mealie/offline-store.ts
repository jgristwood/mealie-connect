/**
 * Mealie data kept on this device, one namespace per account, so recipes,
 * meal plans and shopping lists stay available offline. Changes made while
 * offline wait in an outbox until the server can be reached again.
 */
import { kvDelete, kvDeletePrefix, kvGet, kvSet } from '../../lib/offline-db'
import type {
  MealieCategory,
  MealieRecipeDetail,
  MealieRecipeSummary,
  MealieShoppingList,
  MealieShoppingListItem,
  MealieTag,
  MealieWeekPlan,
} from '../../types/mealie'

export interface MealPlanEntryInput {
  date: string
  entryType: string
  title?: string
  text?: string
  recipeId?: string
}

/** A change made offline, replayed against Mealie in order once online. */
export type OutboxOp =
  | { id: string; kind: 'shopping-add'; listId: string; tempId: string; body: Record<string, unknown> }
  | { id: string; kind: 'shopping-update'; listId: string; itemId: string; item: MealieShoppingListItem }
  | { id: string; kind: 'shopping-remove'; listId: string; itemId: string }
  | { id: string; kind: 'mealplan-create'; tempId: string; body: MealPlanEntryInput }
  | { id: string; kind: 'mealplan-delete'; entryId: string }
  | { id: string; kind: 'recipe-made'; recipe: { id: string; slug: string }; subject: string; timestamp: string }

export interface OfflineMeta {
  lastSyncedAt?: string
  /** Set once every recipe has been downloaded for offline use. */
  allRecipesSavedAt?: string
}

const TEMP_ID_PREFIX = 'offline-'
/** Images bigger than this aren't kept, to stay well within device storage. */
const MAX_CACHED_IMAGE_BYTES = 2 * 1024 * 1024

export function isTempId(id: string | undefined): boolean {
  return Boolean(id?.startsWith(TEMP_ID_PREFIX))
}

export function newTempId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${TEMP_ID_PREFIX}${random}`
}

/** Short, stable fingerprint of a token, so each account gets its own cache
 * without storing the token itself in the key. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function offlineNamespace(baseUrl: string, token: string | undefined): string {
  return `${baseUrl.replace(/\/+$/, '')}#${fingerprint(token ?? '')}`
}

const SUMMARY_FIELDS = [
  'id', 'name', 'slug', 'description', 'image', 'totalTime', 'prepTime', 'cookTime', 'servings', 'recipeServings',
  'tags', 'categories', 'recipeCategory', 'createdAt', 'dateAdded', 'dateUpdated', 'updatedAt',
] as const

/** The list-view fields of a recipe, without its ingredients and steps. */
export function toRecipeSummary(recipe: MealieRecipeDetail): MealieRecipeSummary {
  const source = recipe as unknown as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  for (const field of SUMMARY_FIELDS) if (source[field] !== undefined) summary[field] = source[field]
  return summary as unknown as MealieRecipeSummary
}

const locks = new Map<string, Promise<unknown>>()

export class OfflineStore {
  readonly namespace: string

  constructor(namespace: string) {
    this.namespace = namespace
  }

  private key(...parts: string[]): string {
    return `${this.namespace}|${parts.join('|')}`
  }

  /** Runs `task` after any earlier task on this account finishes, so
   * read-modify-write updates never interleave. */
  lock<T>(task: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.namespace) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    locks.set(this.namespace, next.catch(() => undefined))
    return next
  }

  // Recipes ---------------------------------------------------------------

  async getRecipeIndex(): Promise<Record<string, MealieRecipeSummary>> {
    return (await kvGet<Record<string, MealieRecipeSummary>>(this.key('recipes'))) ?? {}
  }

  async mergeRecipeSummaries(recipes: MealieRecipeSummary[], replaceAll = false): Promise<void> {
    if (recipes.length === 0 && !replaceAll) return
    await this.lock(async () => {
      const index = replaceAll ? {} : await this.getRecipeIndex()
      for (const recipe of recipes) index[recipe.id] = recipe
      await kvSet(this.key('recipes'), index)
    })
  }

  async getRecipeDetail(slugOrId: string): Promise<MealieRecipeDetail | undefined> {
    const id = (await kvGet<string>(this.key('slug', slugOrId))) ?? slugOrId
    return await kvGet<MealieRecipeDetail>(this.key('recipe', id))
  }

  async saveRecipeDetail(recipe: MealieRecipeDetail): Promise<void> {
    await kvSet(this.key('recipe', recipe.id), recipe)
    if (recipe.slug) await kvSet(this.key('slug', recipe.slug), recipe.id)
    await this.mergeRecipeSummaries([toRecipeSummary(recipe)])
  }

  async removeRecipe(slugOrId: string): Promise<void> {
    const detail = await this.getRecipeDetail(slugOrId)
    const id = detail?.id ?? slugOrId
    await this.lock(async () => {
      const index = await this.getRecipeIndex()
      const match = index[id] ?? Object.values(index).find((recipe) => recipe.slug === slugOrId)
      if (match) delete index[match.id]
      await kvSet(this.key('recipes'), index)
    })
    await kvDelete(this.key('recipe', id))
  }

  /** Recipe details saved on this device, for offline ingredient searches. */
  async getRecipeDetails(ids: string[]): Promise<Map<string, MealieRecipeDetail>> {
    const details = await Promise.all(ids.map((id) => kvGet<MealieRecipeDetail>(this.key('recipe', id))))
    const result = new Map<string, MealieRecipeDetail>()
    details.forEach((detail, index) => { if (detail) result.set(ids[index] as string, detail) })
    return result
  }

  // Images ----------------------------------------------------------------

  async getImage(url: string): Promise<Blob | undefined> {
    return await kvGet<Blob>(this.key('image', url))
  }

  async saveImage(url: string, blob: Blob): Promise<void> {
    if (blob.size > MAX_CACHED_IMAGE_BYTES) return
    await kvSet(this.key('image', url), blob)
  }

  // Categories and tags ---------------------------------------------------

  async getCategories(): Promise<MealieCategory[] | undefined> {
    return await kvGet<MealieCategory[]>(this.key('categories'))
  }

  async saveCategories(categories: MealieCategory[]): Promise<void> {
    await kvSet(this.key('categories'), categories)
  }

  async getTags(): Promise<MealieTag[] | undefined> {
    return await kvGet<MealieTag[]>(this.key('tags'))
  }

  async saveTags(tags: MealieTag[]): Promise<void> {
    await kvSet(this.key('tags'), tags)
  }

  // Shopping lists --------------------------------------------------------

  private async getListRecord(): Promise<Record<string, MealieShoppingList> | undefined> {
    return await kvGet<Record<string, MealieShoppingList>>(this.key('lists'))
  }

  async getShoppingLists(): Promise<MealieShoppingList[] | undefined> {
    const record = await this.getListRecord()
    return record ? Object.values(record) : undefined
  }

  async getShoppingList(id: string): Promise<MealieShoppingList | undefined> {
    return (await this.getListRecord())?.[id]
  }

  /** Saves the list overview. Mealie's overview can omit items, so items
   * already saved for a list are kept until its full copy is fetched. */
  async saveShoppingLists(lists: MealieShoppingList[]): Promise<void> {
    await this.lock(async () => {
      const previous = (await this.getListRecord()) ?? {}
      const next: Record<string, MealieShoppingList> = {}
      for (const list of lists) {
        const saved = previous[list.id]
        next[list.id] = (list.items?.length ?? 0) === 0 && saved?.items?.length ? { ...list, items: saved.items } : list
      }
      await kvSet(this.key('lists'), next)
    })
  }

  async saveShoppingList(list: MealieShoppingList): Promise<void> {
    await this.lock(async () => {
      const record = (await this.getListRecord()) ?? {}
      record[list.id] = list
      await kvSet(this.key('lists'), record)
    })
  }

  async removeShoppingList(id: string): Promise<void> {
    await this.lock(async () => {
      const record = await this.getListRecord()
      if (!record) return
      delete record[id]
      await kvSet(this.key('lists'), record)
    })
  }

  /** Applies a change to a saved list's items. Caller must hold the lock. */
  async updateListItemsLocked(listId: string, update: (items: MealieShoppingListItem[]) => MealieShoppingListItem[]): Promise<MealieShoppingList | undefined> {
    const record = (await this.getListRecord()) ?? {}
    const list = record[listId]
    if (!list) return undefined
    const updated = { ...list, items: update(list.items ?? []) }
    record[listId] = updated
    await kvSet(this.key('lists'), record)
    return updated
  }

  // Meal plans ------------------------------------------------------------

  private async getMealPlanRecord(): Promise<Record<string, MealieWeekPlan>> {
    return (await kvGet<Record<string, MealieWeekPlan>>(this.key('mealplans'))) ?? {}
  }

  async hasMealPlans(): Promise<boolean> {
    return (await kvGet(this.key('mealplans'))) !== undefined
  }

  async getMealPlans(startDate?: string, endDate?: string): Promise<MealieWeekPlan[]> {
    const entries = Object.values(await this.getMealPlanRecord())
    return entries.filter((entry) => (!startDate || (entry.date ?? '') >= startDate) && (!endDate || (entry.date ?? '') <= endDate))
  }

  /** Replaces the saved entries for a date range with what Mealie returned.
   * Entries created offline and not yet synced are kept. */
  async saveMealPlans(entries: MealieWeekPlan[], startDate?: string, endDate?: string): Promise<void> {
    await this.lock(async () => {
      const record = await this.getMealPlanRecord()
      for (const [id, entry] of Object.entries(record)) {
        const inRange = (!startDate || (entry.date ?? '') >= startDate) && (!endDate || (entry.date ?? '') <= endDate)
        if (inRange && !isTempId(id)) delete record[id]
      }
      for (const entry of entries) record[entry.id] = entry
      await kvSet(this.key('mealplans'), record)
    })
  }

  /** Adds or removes saved meal-plan entries. Caller must hold the lock. */
  async updateMealPlansLocked(update: (record: Record<string, MealieWeekPlan>) => void): Promise<void> {
    const record = await this.getMealPlanRecord()
    update(record)
    await kvSet(this.key('mealplans'), record)
  }

  async upsertMealPlan(entry: MealieWeekPlan): Promise<void> {
    await this.lock(() => this.updateMealPlansLocked((record) => { record[entry.id] = entry }))
  }

  async removeMealPlan(id: string): Promise<void> {
    await this.lock(() => this.updateMealPlansLocked((record) => { delete record[id] }))
  }

  // Outbox ----------------------------------------------------------------

  async getOutbox(): Promise<OutboxOp[]> {
    return (await kvGet<OutboxOp[]>(this.key('outbox'))) ?? []
  }

  async setOutboxLocked(ops: OutboxOp[]): Promise<void> {
    await kvSet(this.key('outbox'), ops)
  }

  /** Maps IDs given to things created offline to the IDs Mealie assigned. */
  async getIdMap(): Promise<Record<string, string>> {
    return (await kvGet<Record<string, string>>(this.key('idmap'))) ?? {}
  }

  async setIdMapLocked(map: Record<string, string>): Promise<void> {
    await kvSet(this.key('idmap'), map)
  }

  // Housekeeping ----------------------------------------------------------

  async getMeta(): Promise<OfflineMeta> {
    return (await kvGet<OfflineMeta>(this.key('meta'))) ?? {}
  }

  async updateMeta(changes: Partial<OfflineMeta>): Promise<OfflineMeta> {
    return await this.lock(async () => {
      const meta = { ...(await this.getMeta()), ...changes }
      await kvSet(this.key('meta'), meta)
      return meta
    })
  }

  async clear(): Promise<void> {
    await this.lock(() => kvDeletePrefix(`${this.namespace}|`))
  }
}
