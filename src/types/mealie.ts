export type AuthMethod = 'password' | 'token'

export interface MealieProfile {
  id: string
  name: string
  server: string
  authMethod: AuthMethod
  username?: string
  displayName?: string
  token?: string
}

export interface MealieCategory {
  id: string
  name: string
  slug?: string
}

export interface MealieTag {
  id: string
  name: string
  slug?: string
}

export interface MealieIngredient {
  id?: string
  food?: string
  name?: string
  quantity?: number | string
  unit?: string
  note?: string
  display?: string
}

export interface MealieInstructionStep {
  id?: string
  title?: string
  text?: string
  instruction?: string
  step?: number
}

export interface ApiConnectionState {
  connected: boolean
  message: string
  status: 'idle' | 'loading' | 'success' | 'error'
}

export interface MealieRecipeSummary {
  id: string
  name: string
  slug: string
  description?: string
  image?: string
  totalTime?: number | string
  prepTime?: number | string
  cookTime?: number | string
  servings?: number
  tags?: MealieTag[]
  categories?: MealieCategory[]
}

export interface MealieRecipeDetail extends MealieRecipeSummary {
  ingredients?: MealieIngredient[]
  instructions?: MealieInstructionStep[]
  notes?: string
  url?: string
  rating?: number
}

export interface MealieShoppingListItem {
  id?: string
  quantity?: number | string
  unit?: string
  food?: string
  note?: string
  checked?: boolean
  display?: string
}

export interface MealieShoppingList {
  id: string
  name: string
  createdAt?: string
  updatedAt?: string
  items?: MealieShoppingListItem[]
}

export interface MealiePlanEntry {
  id?: string
  recipeId?: string
  recipe?: MealieRecipeSummary
  title?: string
  note?: string
}

export interface MealieMealPlanDay {
  day?: number
  date?: string
  breakfast?: MealiePlanEntry
  lunch?: MealiePlanEntry
  dinner?: MealiePlanEntry
  side?: MealiePlanEntry
}

export interface MealieWeekPlan {
  id: string
  date?: string
  entryType?: string
  title?: string
  text?: string
  recipeId?: string
  recipe?: MealieRecipeSummary
  startDate?: string
  endDate?: string
  groupId?: string
  planDays?: MealieMealPlanDay[]
}

/** The only meal types offered when creating a new meal-plan entry. */
export const PLANNABLE_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const
export type PlannableMealType = (typeof PLANNABLE_MEAL_TYPES)[number]

export type ThemeName = 'purple' | 'blue' | 'red' | 'green' | 'dark'

export type IngredientMatchMode = 'any' | 'all'

export interface DinnerRouletteFilters {
  categoryId?: string
  tagIds?: string[]
  maxPrepTime?: number
  maxCookTime?: number
  ingredients?: string[]
  ingredientMode?: IngredientMatchMode
}
