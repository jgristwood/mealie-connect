import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { KeepAwake } from '@capacitor-community/keep-awake'
import type { PluginListenerHandle } from '@capacitor/core'
import { Network } from '@capacitor/network'
import {
  BookOpen,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Dice5,
  Download,
  Home,
  ListChecks,
  Minus,
  Pencil,
  Plus,
  Refrigerator,
  Search,
  Settings,
  ShoppingCart,
  Utensils,
  X,
} from 'lucide-react'
import { authService } from './services/auth/auth-service'
import { MealieClient, formatMealieTime, groupMealPlanEntriesIntoSlots, type MealPlanSlot } from './services/mealie/mealie-client'
import { ACCENTS, THEME_MODES, getStoredTheme, setTheme as persistTheme, type ThemePreference } from './lib/theme'
import { isAndroidPlatform, isExternalHttpUrl, isNativePlatform, openExternalUrl, removeNativeListener } from './lib/native'
import { StepTimerButtons, TimerTray } from './components/cook-timers'
import { useCookTimers } from './lib/use-cook-timers'
import { canScaleIngredient, formatQuantity, scaleIngredientText } from './lib/ingredients'
import { findRecipesByIngredients, type IngredientFinderResult } from './lib/ingredient-finder'
import defaultRecipeImage from './assets/default-image.jpg'
import type {
  AuthMethod,
  IngredientMatchMode,
  MealieCategory,
  MealieIngredient,
  MealieInstructionStep,
  MealieProfile,
  MealieRecipeDetail,
  MealieRecipeSummary,
  MealieShoppingList,
  MealieShoppingListItem,
  MealieTag,
  MealieWeekPlan,
  PlannableMealType,
} from './types/mealie'
import { EXTRA_MEAL_TYPES, MAIN_MEAL_TYPES, PLANNABLE_MEAL_TYPES } from './types/mealie'
import './App.css'

const APP_VERSION = __APP_VERSION__
const RECIPES_PAGE_SIZE = 50
const HOME_RECIPE_COUNT = 7
const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  side: 'Side',
  snack: 'Snack',
}

/** The name shown for a meal-plan entry: its recipe, else the typed-in title. */
function mealPlanEntryName(entry: MealieWeekPlan): string {
  return entry.recipe?.name || entry.title || entry.text || 'Untitled meal'
}

/** The meal types to show for a day: the main meals always, sides and
 * snacks only when something is planned. */
function visibleMealTypes(hasEntries: (mealType: PlannableMealType) => boolean): PlannableMealType[] {
  return [...MAIN_MEAL_TYPES, ...EXTRA_MEAL_TYPES.filter(hasEntries)]
}

type ConnectivityState = 'online' | 'offline' | 'server-unreachable' | 'auth-failed'

/** Recipe filters that are applied on this device rather than by Mealie. */
interface RecipeExtraFilters {
  maxPrepTime?: number
  maxCookTime?: number
  ingredients: string[]
  ingredientMode: IngredientMatchMode
}
const NO_EXTRA_FILTERS: RecipeExtraFilters = { ingredients: [], ingredientMode: 'any' }
const TIME_LIMIT_PRESETS = [15, 30, 45, 60]

/** "Any / 15 min / 30 min..." chips that set a maximum time in minutes. */
function TimeLimitChips({ label, value, onChange }: { label: string; value?: number; onChange: (value?: number) => void }) {
  return (
    <div className="chip-list" role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={value === undefined} className={value === undefined ? 'chip active' : 'chip'} onClick={() => onChange(undefined)}>Any</button>
      {TIME_LIMIT_PRESETS.map((minutes) => (
        <button key={minutes} type="button" role="radio" aria-checked={value === minutes} className={value === minutes ? 'chip active' : 'chip'} onClick={() => onChange(minutes)}>
          {minutes === 60 ? 'Up to 1 h' : `Up to ${minutes} min`}
        </button>
      ))}
    </div>
  )
}

function useModalEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])
}


function NativeConnectionStatus({ state }: { state: ConnectivityState | null }) {
  if (!state) return null
  const config: Record<ConnectivityState, { label: string; className: string }> = {
    online: { label: 'Online', className: 'native-connection-status online' },
    offline: { label: 'Offline', className: 'native-connection-status offline' },
    'server-unreachable': { label: 'Server unreachable', className: 'native-connection-status warning' },
    'auth-failed': { label: 'Authentication required', className: 'native-connection-status warning' },
  }
  return <div className={config[state].className}>{config[state].label}</div>
}

function isAuthErrorMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('sign in again') || lower.includes('authentication failed')
}

/** Error banner that offers a "Sign in again" link when the error is an
 * expired or rejected login. */
function ErrorMessage({ message, activeProfile }: { message: string; activeProfile?: MealieProfile | null }) {
  if (!message) return null
  return (
    <p className="error-message">
      {message}
      {isAuthErrorMessage(message) ? (
        <>
          {' '}
          <Link to={activeProfile ? `/setup?server=${encodeURIComponent(activeProfile.server)}` : '/setup'}>Sign in again</Link>
        </>
      ) : null}
    </p>
  )
}

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isExternalHttpUrl(href)) return
    if (!isNativePlatform()) return
    event.preventDefault()
    await openExternalUrl(href)
  }
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => void handleClick(event)}>
      {children}
    </a>
  )
}

/** Free-text list of ingredients, shown as removable chips. */
function IngredientChipsInput({ id, label, values, onChange, placeholder = 'Chicken, rice, garlic...' }: {
  id: string
  label: string
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    // Accept a comma-separated list as well as one ingredient at a time.
    const additions = draft.split(',').map((value) => value.trim()).filter(Boolean)
    if (additions.length === 0) return
    const known = new Set(values.map((value) => value.toLowerCase()))
    const next = [...values]
    for (const value of additions) {
      if (known.has(value.toLowerCase())) continue
      known.add(value.toLowerCase())
      next.push(value)
    }
    onChange(next)
    setDraft('')
  }
  return (
    <div className="ingredient-chips-input">
      <div className="roulette-ingredient-input">
        <label className="sr-only" htmlFor={id}>{label}</label>
        <input id={id} type="text" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} placeholder={placeholder} enterKeyHint="done" />
        <button type="button" className="btn-secondary btn-sm" onClick={add}>Add</button>
      </div>
      {values.length > 0 ? (
        <div className="chip-list">
          {values.map((value) => (
            <button key={value} type="button" className="chip active" onClick={() => onChange(values.filter((item) => item !== value))} aria-label={`Remove ${value}`}>{value} <X size={12} /></button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function MatchModeToggle({ mode, onChange }: { mode: IngredientMatchMode; onChange: (mode: IngredientMatchMode) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Ingredient matching">
      <button type="button" role="radio" aria-checked={mode === 'any'} className={mode === 'any' ? 'segmented-btn active' : 'segmented-btn'} onClick={() => onChange('any')}>Match ANY</button>
      <button type="button" role="radio" aria-checked={mode === 'all'} className={mode === 'all' ? 'segmented-btn active' : 'segmented-btn'} onClick={() => onChange('all')}>Match ALL</button>
    </div>
  )
}

/** "Perfect match" or "Missing 2 ingredients" for an ingredient search result. */
function MatchBadge({ result }: { result: IngredientFinderResult }) {
  const count = result.missing.length
  return count === 0
    ? <span className="match-badge perfect">Perfect match</span>
    : <span className="match-badge">Missing {count} ingredient{count === 1 ? '' : 's'}</span>
}

const normalizeInstructionSteps = (recipe: MealieRecipeDetail): MealieInstructionStep[] => {
  if (Array.isArray((recipe as MealieRecipeDetail & { steps?: MealieInstructionStep[] }).steps)) {
    return (recipe as MealieRecipeDetail & { steps?: MealieInstructionStep[] }).steps ?? []
  }
  if (Array.isArray(recipe.instructions)) {
    return recipe.instructions
  }
  return []
}

function AppHeader({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const location = useLocation()
  const isActive = (path: string) => location.pathname === path || (path !== '/' && location.pathname.startsWith(path))

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link className="header-brand" to="/" aria-label="Mealie Connect home">
          <img className="header-brand-logo" src="/mealie-connect-logo.svg" alt="" />
          <span className="header-brand-name">Mealie Connect</span>
        </Link>

        {activeProfile ? (
          <nav className="header-nav" aria-label="Primary navigation">
            <Link className={location.pathname === '/' ? 'header-nav-link active' : 'header-nav-link'} to="/">
              <Home /><span>Home</span>
            </Link>
            <Link className={isActive('/recipes') ? 'header-nav-link active' : 'header-nav-link'} to="/recipes">
              <BookOpen /><span>Recipes</span>
            </Link>
            <Link className={isActive('/roulette') ? 'header-nav-link active' : 'header-nav-link'} to="/roulette">
              <Dice5 /><span>Roulette</span>
            </Link>
            <Link className={isActive('/ingredients') ? 'header-nav-link active' : 'header-nav-link'} to="/ingredients">
              <Refrigerator /><span>Finder</span>
            </Link>
            <Link className={isActive('/meal-plan') ? 'header-nav-link active' : 'header-nav-link'} to="/meal-plan">
              <Calendar /><span>Meal Plan</span>
            </Link>
            <Link className={isActive('/shopping') ? 'header-nav-link active' : 'header-nav-link'} to="/shopping">
              <ShoppingCart /><span>Shopping</span>
            </Link>
          </nav>
        ) : <div className="header-nav" />}

        <div className="header-actions">
          {activeProfile ? (
            <>
              <Link className="header-import-btn" to="/import" aria-label="Import a recipe" title="Import a recipe">
                <Plus />
              </Link>
              <Link className="header-account-btn" to="/settings">
                <span className="header-account-dot" aria-hidden="true" />
                <span>{activeProfile.displayName ?? activeProfile.username ?? 'Account'}</span>
              </Link>
            </>
          ) : (
            <Link className="header-icon-btn" to="/settings" aria-label="Settings"><Settings /></Link>
          )}
        </div>
      </div>
    </header>
  )
}

function MobileNav({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const location = useLocation()
  if (!activeProfile) return null
  const isActive = (path: string) => location.pathname === path || (path !== '/' && location.pathname.startsWith(path))
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <div className="mobile-nav-inner">
        <Link className={location.pathname === '/' ? 'mobile-nav-item active' : 'mobile-nav-item'} to="/">
          <Home /><span>Home</span>
        </Link>
        <Link className={isActive('/recipes') ? 'mobile-nav-item active' : 'mobile-nav-item'} to="/recipes">
          <BookOpen /><span>Recipes</span>
        </Link>
        <Link className={isActive('/meal-plan') ? 'mobile-nav-item active' : 'mobile-nav-item'} to="/meal-plan">
          <Calendar /><span>Plan</span>
        </Link>
        <Link className={isActive('/shopping') ? 'mobile-nav-item active' : 'mobile-nav-item'} to="/shopping">
          <ShoppingCart /><span>Shop</span>
        </Link>
        <Link className={isActive('/settings') ? 'mobile-nav-item active' : 'mobile-nav-item'} to="/settings">
          <Settings /><span>Settings</span>
        </Link>
      </div>
    </nav>
  )
}

function ThemeMenu() {
  const [current, setCurrent] = useState<ThemePreference>(() => getStoredTheme())
  const choose = (next: Partial<ThemePreference>) => {
    const preference = { ...current, ...next }
    persistTheme(preference)
    setCurrent(preference)
  }
  return (
    <div className="theme-menu">
      <div className="theme-menu-group">
        <p className="theme-menu-label" id="theme-mode-label">Mode</p>
        <div className="segmented" role="radiogroup" aria-labelledby="theme-mode-label">
          {THEME_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={current.mode === mode.id}
              className={current.mode === mode.id ? 'segmented-btn active' : 'segmented-btn'}
              onClick={() => choose({ mode: mode.id })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>
      <div className="theme-menu-group">
        <p className="theme-menu-label" id="theme-accent-label">Accent</p>
        <div className="theme-accent-list" role="radiogroup" aria-labelledby="theme-accent-label">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              role="radio"
              aria-checked={current.accent === accent.id}
              className={current.accent === accent.id ? 'theme-swatch-btn active' : 'theme-swatch-btn'}
              onClick={() => choose({ accent: accent.id })}
            >
              <span className="theme-swatch-dot" style={{ backgroundColor: accent.swatch }} aria-hidden="true" />
              <span>{accent.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [pathname])
  return null
}

function App() {
  const [profiles, setProfiles] = useState<MealieProfile[]>([])
  const [activeProfile, setActiveProfile] = useState<MealieProfile | null>(null)
  const [recipes, setRecipes] = useState<MealieRecipeSummary[]>([])
  const [categories, setCategories] = useState<MealieCategory[]>([])
  const [tags, setTags] = useState<MealieTag[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [extraFilters, setExtraFilters] = useState<RecipeExtraFilters>(NO_EXTRA_FILTERS)
  const [ingredientMatches, setIngredientMatches] = useState<Map<string, IngredientFinderResult>>(() => new Map())
  const [loading, setLoading] = useState(false)
  const [loadingMoreRecipes, setLoadingMoreRecipes] = useState(false)
  const [hasMoreRecipes, setHasMoreRecipes] = useState(false)
  const [error, setError] = useState('')
  const [networkConnected, setNetworkConnected] = useState(true)
  const [connectivityState, setConnectivityState] = useState<ConnectivityState | null>(null)
  const [homeRecipes, setHomeRecipes] = useState<MealieRecipeSummary[]>([])
  const [homeLoading, setHomeLoading] = useState(false)
  const [homeError, setHomeError] = useState('')

  const loadProfiles = useCallback(async () => {
    const [nextProfiles, nextActiveProfile] = await Promise.all([
      authService.listProfiles(),
      authService.getActiveProfile(),
    ])
    setProfiles(nextProfiles)
    setActiveProfile(nextActiveProfile)
  }, [])

  useEffect(() => { void loadProfiles() }, [loadProfiles])

  useEffect(() => {
    if (!isNativePlatform()) return
    let statusListener: PluginListenerHandle | undefined
    let mounted = true
    const initializeNetwork = async () => {
      const status = await Network.getStatus()
      if (mounted) setNetworkConnected(status.connected)
      statusListener = await Network.addListener('networkStatusChange', (nextStatus) => {
        setNetworkConnected(nextStatus.connected)
      })
    }
    void initializeNetwork()
    return () => {
      mounted = false
      void removeNativeListener(statusListener)
    }
  }, [])

  useEffect(() => {
    if (!isNativePlatform() || !isAndroidPlatform()) return
    let backButtonListener: PluginListenerHandle | undefined
    const initializeBackButton = async () => {
      backButtonListener = await CapacitorApp.addListener('backButton', () => {
        if (document.querySelector('.modal-overlay')) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
          return
        }
        if (window.location.pathname !== '/') {
          window.history.back()
          return
        }
        void CapacitorApp.exitApp()
      })
    }
    void initializeBackButton()
    return () => { void removeNativeListener(backButtonListener) }
  }, [])

  useEffect(() => {
    if (!isNativePlatform()) return
    if (!networkConnected) { setConnectivityState('offline'); return }
    if (!activeProfile) { setConnectivityState('online'); return }
    let cancelled = false
    const checkProfileConnectivity = async () => {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      try {
        await client.getHealth()
        await client.getCurrentUser()
        if (!cancelled) setConnectivityState('online')
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message.toLowerCase() : ''
        if (!cancelled) {
          setConnectivityState(
            message.includes('sign in again') || message.includes('authentication') ? 'auth-failed' : 'server-unreachable',
          )
        }
      }
    }
    void checkProfileConnectivity()
    return () => { cancelled = true }
  }, [activeProfile, networkConnected])

  useEffect(() => {
    if (!activeProfile) {
      setRecipes([])
      setCategories([])
      setTags([])
      setHasMoreRecipes(false)
      setLoading(false)
      return
    }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    let cancelled = false
    const { maxPrepTime, maxCookTime, ingredients, ingredientMode } = extraFilters
    const filters = { search: searchTerm, categories: selectedCategories, tags: selectedTags, maxPrepTime, maxCookTime }
    // Time and ingredient filters are applied on this device, so they need the
    // whole matching collection rather than one page at a time.
    const loadRecipes = async (): Promise<{ recipes: MealieRecipeSummary[]; paged: boolean; matches: Map<string, IngredientFinderResult> }> => {
      if (ingredients.length > 0) {
        const results = await findRecipesByIngredients(client, ingredients, { mode: ingredientMode, filters })
        return { recipes: results.map((result) => result.recipe), paged: false, matches: new Map(results.map((result) => [result.recipe.id, result])) }
      }
      if (maxPrepTime !== undefined || maxCookTime !== undefined) {
        return { recipes: await client.getAllRecipes(filters), paged: false, matches: new Map() }
      }
      return { recipes: await client.getRecipes({ ...filters, page: 1, perPage: RECIPES_PAGE_SIZE }), paged: true, matches: new Map() }
    }
    const timeout = window.setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const results = await Promise.allSettled([loadRecipes(), client.getCategories(), client.getTags()])
        if (cancelled) return
        const loaded = results[0]?.status === 'fulfilled' ? results[0].value : { recipes: [], paged: false, matches: new Map<string, IngredientFinderResult>() }
        const nextCategories = results[1]?.status === 'fulfilled' ? results[1].value : []
        const nextTags = results[2]?.status === 'fulfilled' ? results[2].value : []
        setRecipes(loaded.recipes)
        setIngredientMatches(loaded.matches)
        setHasMoreRecipes(loaded.paged && loaded.recipes.length === RECIPES_PAGE_SIZE)
        setCategories(nextCategories)
        setTags(nextTags)
        if (results[0]?.status === 'rejected') {
          const message = results[0].reason instanceof Error ? results[0].reason.message : 'Unable to load recipes.'
          setError(message)
        }
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'Unable to load Mealie data.'
        setError(message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timeout) }
  }, [activeProfile, searchTerm, selectedCategories, selectedTags, extraFilters])

  // The home page shows the newest recipes, independent of whatever search or
  // filters are active on the Recipes page.
  useEffect(() => {
    if (!activeProfile) { setHomeRecipes([]); setHomeError(''); return }
    let cancelled = false
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setHomeLoading(true)
    setHomeError('')
    client.getRecipes({ page: 1, perPage: HOME_RECIPE_COUNT, orderBy: 'created_at', orderDirection: 'desc' })
      .then((nextRecipes) => { if (!cancelled) setHomeRecipes(nextRecipes) })
      .catch((err: unknown) => { if (!cancelled) setHomeError(err instanceof Error ? err.message : 'Unable to load recipes.') })
      .finally(() => { if (!cancelled) setHomeLoading(false) })
    return () => { cancelled = true }
  }, [activeProfile])

  const loadMoreRecipes = useCallback(async () => {
    if (!activeProfile || loading || loadingMoreRecipes || !hasMoreRecipes) return
    setLoadingMoreRecipes(true)
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      const nextRecipes = await client.getRecipes({
        search: searchTerm,
        categories: selectedCategories,
        tags: selectedTags,
        page: Math.floor(recipes.length / RECIPES_PAGE_SIZE) + 1,
        perPage: RECIPES_PAGE_SIZE,
      })
      setRecipes((current) => [...current, ...nextRecipes])
      setHasMoreRecipes(nextRecipes.length === RECIPES_PAGE_SIZE)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load more recipes.'
      setError(message)
    } finally {
      setLoadingMoreRecipes(false)
    }
  }, [activeProfile, hasMoreRecipes, loading, loadingMoreRecipes, recipes.length, searchTerm, selectedCategories, selectedTags])

  const signIn = async (server: string, method: AuthMethod, username?: string, password?: string, token?: string) => {
    const profile = await authService.signIn({ server, method, username, password, token })
    await loadProfiles()
    setActiveProfile(profile)
  }

  const signOut = () => {
    authService.signOut()
    setActiveProfile(null)
    void loadProfiles()
  }

  const selectProfile = (profile: MealieProfile) => {
    authService.setActiveProfile(profile.id)
    setActiveProfile(profile)
  }

  const removeProfile = async (profile: MealieProfile) => {
    await authService.removeProfile(profile.id)
    if (activeProfile?.id === profile.id) setActiveProfile(null)
    await loadProfiles()
  }

  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<HomePage activeProfile={activeProfile} recipes={homeRecipes} loading={homeLoading} error={homeError} />} />
        <Route path="/settings" element={<SettingsPage activeProfile={activeProfile} profiles={profiles} onSelectProfile={selectProfile} onRemoveProfile={removeProfile} onSignOut={signOut} connectivityState={connectivityState} />} />
        <Route path="/setup" element={<SetupPage onSignIn={signIn} profiles={profiles} onBack={() => window.history.back()} onSelectProfile={selectProfile} />} />
        <Route path="/import" element={<ImportRecipePage activeProfile={activeProfile} />} />
        <Route path="/recipes" element={
          <RecipesPage
            activeProfile={activeProfile} recipes={recipes} categories={categories} tags={tags}
            searchTerm={searchTerm} setSearchTerm={setSearchTerm}
            selectedCategories={selectedCategories} setSelectedCategories={setSelectedCategories}
            selectedTags={selectedTags} setSelectedTags={setSelectedTags}
            extraFilters={extraFilters} setExtraFilters={setExtraFilters} ingredientMatches={ingredientMatches}
            loading={loading} loadingMore={loadingMoreRecipes} hasMore={hasMoreRecipes}
            onLoadMore={loadMoreRecipes} error={error}
          />
        } />
        <Route path="/recipes/:slug" element={<RecipeDetailPage activeProfile={activeProfile} />} />
        <Route path="/cook/:slug" element={<CookModePage activeProfile={activeProfile} />} />
        <Route path="/shopping" element={<ShoppingListsPage activeProfile={activeProfile} />} />
        <Route path="/shopping/:id" element={<ShoppingListDetailPage activeProfile={activeProfile} />} />
        <Route path="/meal-plan" element={<MealPlanPage activeProfile={activeProfile} />} />
        <Route path="/ingredients" element={<IngredientFinderPage activeProfile={activeProfile} />} />
        <Route path="/random-recipe" element={<RouletteRedirect />} />
        <Route path="/roulette" element={<DinnerRoulettePage activeProfile={activeProfile} />} />
      </Routes>
      <MobileNav activeProfile={activeProfile} />
      <NativeConnectionStatus state={connectivityState} />
    </BrowserRouter>
  )
}

type MainMealType = (typeof MAIN_MEAL_TYPES)[number]

const PLANNED_HERO_LABELS: Record<MainMealType, string> = {
  breakfast: "Today's breakfast",
  lunch: "Today's lunch",
  dinner: "Tonight's dinner",
}

/** Picks the next meal still to come today that has a recipe attached, so
 * the home hero shows what's actually planned instead of a random recipe. */
function pickPlannedHero(entries: MealieWeekPlan[], hour: number): { recipe: MealieRecipeSummary; label: string } | null {
  const upcoming: MainMealType[] = hour < 10 ? ['breakfast', 'lunch', 'dinner'] : hour < 14 ? ['lunch', 'dinner'] : ['dinner']
  for (const mealType of upcoming) {
    const entry = entries.find((candidate) => (candidate.entryType ?? '').toLowerCase() === mealType && candidate.recipe?.id)
    if (entry?.recipe) return { recipe: entry.recipe, label: PLANNED_HERO_LABELS[mealType] }
  }
  return null
}

function HomePage({ activeProfile, recipes, loading, error }: {
  activeProfile: MealieProfile | null
  recipes: MealieRecipeSummary[]
  loading: boolean
  error: string
}) {
  const [todayEntries, setTodayEntries] = useState<MealieWeekPlan[]>([])
  const [todayLoaded, setTodayLoaded] = useState(false)

  useEffect(() => {
    if (!activeProfile) { setTodayEntries([]); setTodayLoaded(false); return }
    let cancelled = false
    const todayKey = toDateKey(new Date())
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    client.getMealPlans(todayKey, todayKey)
      .then((entries) => { if (!cancelled) setTodayEntries(entries.filter((entry) => !entry.date || entry.date === todayKey)) })
      .catch(() => { if (!cancelled) setTodayEntries([]) })
      .finally(() => { if (!cancelled) setTodayLoaded(true) })
    return () => { cancelled = true }
  }, [activeProfile])

  const planned = useMemo(() => pickPlannedHero(todayEntries, new Date().getHours()), [todayEntries])
  const featured = planned?.recipe ?? recipes[0] ?? null
  const recent = useMemo(() => (planned ? recipes.slice(0, 6) : recipes.slice(1, 7)), [planned, recipes])
  const todaySlots = useMemo(() => groupMealPlanEntriesIntoSlots(todayEntries), [todayEntries])

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content">
        {!activeProfile ? (
          <>
            <div className="hero hero-empty">
              <div className="hero-content">
                <p className="eyebrow hero-eyebrow">Your cooking space</p>
                <h1 className="hero-title">A calmer way to cook from your Mealie library.</h1>
                <p className="hero-description">Connect your self-hosted Mealie server and bring your recipes into focus.</p>
                <div className="hero-actions">
                  <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
                </div>
              </div>
            </div>
            <section className="home-section">
              <div className="home-tools-grid">
                <div className="home-tool-card">
                  <div className="home-tool-card-icon"><BookOpen /></div>
                  <div className="home-tool-card-label">Browse</div>
                  <div className="home-tool-card-title">Your recipe library</div>
                  <div className="home-tool-card-desc">Search and discover everything you have saved.</div>
                </div>
                <div className="home-tool-card">
                  <div className="home-tool-card-icon"><Calendar /></div>
                  <div className="home-tool-card-label">Plan</div>
                  <div className="home-tool-card-title">Map out your week</div>
                  <div className="home-tool-card-desc">Keep dinner from becoming a daily question.</div>
                </div>
                <div className="home-tool-card">
                  <div className="home-tool-card-icon"><ShoppingCart /></div>
                  <div className="home-tool-card-label">Shop</div>
                  <div className="home-tool-card-title">Build a shopping list</div>
                  <div className="home-tool-card-desc">Turn what you want to cook into a useful list.</div>
                </div>
              </div>
            </section>
          </>
        ) : (
          <>
            {featured && !loading ? (
              <div className="hero">
                <RecipeThumbnail activeProfile={activeProfile} recipe={featured} className="hero-image" size="original" />
                <div className="hero-gradient" aria-hidden="true" />
                <div className="hero-content">
                  <p className="eyebrow hero-eyebrow">{planned ? planned.label : featured.categories?.[0]?.name ?? 'Featured recipe'}</p>
                  <h1 className="hero-title">{featured.name}</h1>
                  {featured.description ? <p className="hero-description">{featured.description}</p> : null}
                  <div className="hero-meta">
                    {featured.totalTime ? <span className="hero-meta-item">{formatMealieTime(featured.totalTime)}</span> : null}
                    {featured.servings ? <span className="hero-meta-item">{featured.servings} servings</span> : null}
                  </div>
                  <div className="hero-actions">
                    <Link className="btn-primary" to={`/recipes/${featured.slug || featured.id}`}>View Recipe</Link>
                    <Link className="btn-secondary" to={`/cook/${featured.slug || featured.id}`}>
                      <Utensils /> Cook Now
                    </Link>
                  </div>
                </div>
              </div>
            ) : loading ? (
              <div className="hero hero-skeleton">
                <div className="hero-gradient" aria-hidden="true" />
                <div className="hero-content">
                  <p className="skeleton-line short" />
                  <p className="skeleton-line medium" />
                  <p className="skeleton-line" />
                </div>
              </div>
            ) : (
              <div className="hero hero-empty">
                <div className="hero-content">
                  <p className="hero-empty-title">Welcome to Mealie Connect</p>
                  <p className="hero-empty-text">Your recipes will appear here once loaded.</p>
                </div>
              </div>
            )}

            {error ? <div style={{marginTop: 'var(--sp-4)'}}><ErrorMessage message={error} activeProfile={activeProfile} /></div> : null}

            {todayLoaded ? (
              <section className="home-section">
                <div className="section-header">
                  <div>
                    <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                    <h2 className="section-title">Today's plan</h2>
                  </div>
                  <Link className="btn-ghost btn-sm" to="/meal-plan">Open meal plan</Link>
                </div>
                <div className="today-plan-grid">
                  {visibleMealTypes((mealType) => todaySlots.some((slot) => slot.entryType === mealType)).map((mealType) => {
                    const entries = todaySlots.find((slot) => slot.entryType === mealType)?.entries ?? []
                    return (
                      <div key={mealType} className="today-plan-card">
                        <p className="today-plan-meal">{MEAL_TYPE_LABELS[mealType]}</p>
                        {entries.length === 0 ? (
                          <Link className="today-plan-empty" to="/meal-plan">Nothing planned · Add</Link>
                        ) : (
                          <ul className="today-plan-list">
                            {entries.map((entry) => (
                              <li key={entry.id}>
                                {entry.recipe?.slug
                                  ? <Link to={`/recipes/${entry.recipe.slug}`}>{mealPlanEntryName(entry)}</Link>
                                  : <span>{mealPlanEntryName(entry)}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : null}

            {recent.length > 0 ? (
              <section className="home-section">
                <div className="section-header">
                  <div>
                    <p className="eyebrow">From your library</p>
                    <h2 className="section-title">Recently added</h2>
                  </div>
                  <Link className="btn-ghost btn-sm" to="/recipes">View all</Link>
                </div>
                <div className="recipe-shelf">
                  {recent.map((recipe) => (
                    <Link key={recipe.id} className="recipe-card" to={`/recipes/${recipe.slug || recipe.id}`}>
                      <div className="recipe-card-image-wrap">
                        <RecipeThumbnail activeProfile={activeProfile} recipe={recipe} />
                      </div>
                      <div className="recipe-card-body">
                        <p className="recipe-card-kicker">{recipe.categories?.[0]?.name ?? 'Recipe'}</p>
                        <h3 className="recipe-card-title">{recipe.name}</h3>
                        {recipe.totalTime ? <p className="recipe-card-meta">{formatMealieTime(recipe.totalTime)}</p> : null}
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="home-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Make the week easier</p>
                  <h2 className="section-title">Cooking tools</h2>
                </div>
              </div>
              <div className="home-tools-grid">
                <Link className="home-tool-card" to="/meal-plan">
                  <div className="home-tool-card-icon"><Calendar /></div>
                  <div className="home-tool-card-label">Plan</div>
                  <div className="home-tool-card-title">Map out your week</div>
                  <div className="home-tool-card-desc">Keep dinner from becoming a daily question.</div>
                </Link>
                <Link className="home-tool-card" to="/shopping">
                  <div className="home-tool-card-icon"><ShoppingCart /></div>
                  <div className="home-tool-card-label">Organize</div>
                  <div className="home-tool-card-title">Build a shopping list</div>
                  <div className="home-tool-card-desc">Turn what you want to cook into a useful list.</div>
                </Link>
                <Link className="home-tool-card" to="/roulette">
                  <div className="home-tool-card-icon"><Dice5 /></div>
                  <div className="home-tool-card-label">Discover</div>
                  <div className="home-tool-card-title">Dinner Roulette</div>
                  <div className="home-tool-card-desc">Let chance pick tonight's recipe.</div>
                </Link>
                <Link className="home-tool-card" to="/ingredients">
                  <div className="home-tool-card-icon"><Refrigerator /></div>
                  <div className="home-tool-card-label">Use it up</div>
                  <div className="home-tool-card-title">Ingredient Finder</div>
                  <div className="home-tool-card-desc">Find recipes that use what you already have.</div>
                </Link>
              </div>
            </section>

            <section className="import-strip">
              <div>
                <p className="eyebrow">Bring something new home</p>
                <h2>Import a recipe</h2>
                <p>Paste a recipe URL to add it to your collection.</p>
              </div>
              <Link className="btn-secondary" to="/import">
                <Download /> Open import
              </Link>
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function SettingsPage({ activeProfile, profiles, onSelectProfile, onRemoveProfile, onSignOut, connectivityState }: {
  activeProfile: MealieProfile | null
  profiles: MealieProfile[]
  onSelectProfile: (profile: MealieProfile) => void
  onRemoveProfile: (profile: MealieProfile) => Promise<void>
  onSignOut: () => void
  connectivityState: ConnectivityState | null
}) {
  const profileLabel = (profile: MealieProfile) => profile.displayName ?? profile.username ?? profile.name
  const confirmRemove = (profile: MealieProfile) => {
    if (!window.confirm(`Remove ${profileLabel(profile)} (${profile.server}) from this device? You can add it again later.`)) return
    void onRemoveProfile(profile)
  }
  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content narrow">
        <div className="page-intro">
          <p className="eyebrow">Preferences</p>
          <h1 className="page-intro-title">Settings</h1>
        </div>

        {!activeProfile ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Settings /></div>
            <p className="empty-state-title">No account connected</p>
            <p className="empty-state-text">Connect a Mealie account to get started.</p>
            <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
          </div>
        ) : (
          <>
            <section className="settings-section">
              <h2 className="settings-section-title">Account</h2>
              <div className="settings-profile-card">
                <div className="settings-profile-avatar">
                  {(activeProfile.displayName ?? activeProfile.username ?? 'M').charAt(0).toUpperCase()}
                </div>
                <div className="settings-profile-info">
                  <p className="settings-profile-name">{activeProfile.displayName ?? activeProfile.username ?? 'Mealie user'}</p>
                  <p className="settings-profile-server">{activeProfile.server}</p>
                </div>
              </div>
              {connectivityState === 'auth-failed' ? (
                <ErrorMessage message="Mealie no longer accepts this login. Please sign in again." activeProfile={activeProfile} />
              ) : null}
              {profiles.length > 1 ? (
                <div className="profile-list">
                  {profiles.map((profile) => (
                    <div key={profile.id} className="profile-list-row">
                      <button
                        type="button"
                        className={activeProfile.id === profile.id ? 'profile-list-item active' : 'profile-list-item'}
                        onClick={() => onSelectProfile(profile)}
                      >
                        {profileLabel(profile)}
                      </button>
                      <button type="button" className="btn-ghost btn-sm" style={{color:'var(--danger)'}} onClick={() => confirmRemove(profile)} aria-label={`Remove ${profileLabel(profile)} from this device`}>
                        <X />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <Link className="btn-ghost btn-sm" to="/setup">Add another account</Link>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">Appearance</h2>
              <ThemeMenu />
            </section>

            <section className="settings-section">
              <div className="settings-signout-actions">
                <button type="button" className="btn-danger" onClick={onSignOut}>Sign out</button>
                <button type="button" className="btn-ghost btn-sm" style={{color:'var(--danger)'}} onClick={() => confirmRemove(activeProfile)}>Remove this account from device</button>
              </div>
            </section>
          </>
        )}
        <p className="settings-version">Mealie Connect v{APP_VERSION}</p>
      </main>
    </div>
  )
}

function SetupPage({ onSignIn, profiles, onBack, onSelectProfile }: {
  onSignIn: (server: string, method: AuthMethod, username?: string, password?: string, token?: string) => Promise<void>
  profiles: MealieProfile[]
  onBack: () => void
  onSelectProfile: (profile: MealieProfile) => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  // In local development with MEALIE_SERVER set, default to the dev proxy.
  const devProxyUrl = __MEALIE_DEV_PROXY_PATH__ ? `${window.location.origin}${__MEALIE_DEV_PROXY_PATH__}` : ''
  const [server, setServer] = useState(() => new URLSearchParams(location.search).get('server') ?? devProxyUrl)
  const [method, setMethod] = useState<AuthMethod>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [corsErrorDetected, setCorsErrorDetected] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setCorsErrorDetected(false)
    try {
      setLoading(true)
      if (!server) throw new Error('Please enter a Mealie server URL.')
      const url = new URL(server)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The server must use http or https.')
      const testClient = new MealieClient({ baseUrl: server })
      const connectionTest = await testClient.testConnection()
      if (!connectionTest.ok) {
        setError(connectionTest.message)
        if (connectionTest.isCorsError) setCorsErrorDetected(true)
        return
      }
      if (method === 'password') {
        if (!username || !password) throw new Error('Enter both a username and password.')
        await onSignIn(server, method, username, password)
      } else {
        if (!token) throw new Error('Enter a Mealie API token.')
        await onSignIn(server, method, undefined, undefined, token)
      }
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect to Mealie.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app-page">
      <AppHeader activeProfile={profiles[0] ?? null} />
      <main className="page-content narrow">
        <div className="sticky-back-bar">
          <button type="button" className="btn-ghost btn-sm" onClick={onBack}>
            <ChevronLeft /> Back
          </button>
        </div>

        <div className="page-intro">
          <p className="eyebrow">Connect to Mealie</p>
          <h1 className="page-intro-title">Bring your cooking space with you.</h1>
          <p className="page-intro-text">Connect your self-hosted server to browse, plan, shop, and cook from one place.</p>
        </div>

        <section className="setup-section">
          <h2>Server connection</h2>
          <form onSubmit={handleSubmit} className="form-stack">
            <div className="form-field">
              <label className="form-label" htmlFor="setup-server">Server URL</label>
              <input id="setup-server" className="form-input" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://mealie.example.com" />
            </div>

            <div className="auth-method-selector" role="radiogroup" aria-label="Authentication method">
              <label className="auth-method-option">
                <input type="radio" name="authMethod" checked={method === 'password'} onChange={() => setMethod('password')} />
                <span>Username and Password</span>
              </label>
              <label className="auth-method-option">
                <input type="radio" name="authMethod" checked={method === 'token'} onChange={() => setMethod('token')} />
                <span>API Token</span>
              </label>
            </div>

            {method === 'password' ? (
              <>
                <div className="form-field">
                  <label className="form-label" htmlFor="setup-username">Username</label>
                  <input id="setup-username" className="form-input" autoComplete="username" autoCapitalize="off" autoCorrect="off" value={username} onChange={(event) => setUsername(event.target.value)} />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="setup-password">Password</label>
                  <input id="setup-password" className="form-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
                </div>
              </>
            ) : (
              <div className="form-field">
                <label className="form-label" htmlFor="setup-token">API Token</label>
                <input id="setup-token" className="form-input" type="password" value={token} onChange={(event) => setToken(event.target.value)} />
              </div>
            )}

            {error ? <div className={corsErrorDetected ? 'cors-error-box' : 'error-message'}>{error}</div> : null}

            {corsErrorDetected && (
              <section className="cors-solution-panel">
                <h3>CORS error: your browser blocked the connection</h3>
                <div className="help-text">
                  <p><strong>What is happening?</strong> Your browser is blocking the connection because your Mealie server does not allow requests from this website ({window.location.origin}).</p>
                  <p><strong>Easiest fix:</strong> use the Android app. It connects directly, so CORS does not apply.</p>
                  <p><strong>Using the web app?</strong> Configure the reverse proxy in front of Mealie (nginx, Caddy, Traefik, etc.) to send these headers, and to answer <code>OPTIONS</code> requests with them:</p>
                  <pre className="help-code">{`Access-Control-Allow-Origin: ${window.location.origin}
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type`}</pre>
                  {devProxyUrl ? (
                    <p><strong>Developing locally?</strong> The dev server is already proxying your Mealie server. Use <code>{devProxyUrl}</code> as the server URL.</p>
                  ) : (
                    <p><strong>Developing locally?</strong> Put <code>MEALIE_SERVER=https://your-mealie-server</code> in a <code>.env.local</code> file and restart <code>npm run dev</code>; the setup page will then use the built-in proxy.</p>
                  )}
                  <p><strong>Running Mealie Connect from source on your computer?</strong> You can use the included local proxy instead:</p>
                  <ol className="proxy-steps">
                    <li>Open a terminal in the Mealie Connect folder and run: <code>node cors-proxy.js</code></li>
                    <li>You should see Proxy is listening on http://localhost:3001</li>
                    <li>In the URL field above, enter: <code>http://localhost:3001</code></li>
                    <li>Click Continue</li>
                  </ol>
                  <p className="small-text">The proxy runs locally on your computer and forwards requests to your actual Mealie server while adding the necessary CORS headers.</p>
                  <p className="small-text">Web browsers also block an https web app from talking to a plain http:// server. If your server is http-only, use the Android app or serve Mealie over https.</p>
                </div>
              </section>
            )}

            <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Connecting...' : 'Continue'}</button>
          </form>
        </section>

        {profiles.length > 0 && (
          <section className="setup-section">
            <h2>Saved connections</h2>
            <div className="profile-list">
              {profiles.map((profile) => (
                <button key={profile.id} type="button" className="setup-profile-btn" onClick={() => { onSelectProfile(profile); navigate('/') }}>
                  <strong>{profile.displayName ?? profile.username ?? profile.name}</strong>
                  <span>{profile.server}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="setup-section">
          <h2>Troubleshooting</h2>
          <div className="help-text">
            <p><strong>NetworkError or CORS error?</strong></p>
            <ul>
              <li>Check that your Mealie server URL is correct (include the protocol: http:// or https://)</li>
              <li>Verify your browser can reach the server</li>
              <li>Ensure the Mealie server is running and accessible from your network</li>
              <li>If you are testing the web app in a browser, your Mealie server or reverse proxy must allow CORS for that browser origin</li>
            </ul>
            <p><strong>Authentication failed?</strong></p>
            <ul>
              <li>Double-check your username and password</li>
              <li>Ensure you are using the correct Mealie account</li>
            </ul>
          </div>
        </section>
      </main>
    </div>
  )
}

function ImportRecipePage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const navigate = useNavigate()
  const [importUrl, setImportUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const handleImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    setError('')
    if (!activeProfile) { setError('Connect a Mealie account before importing a recipe.'); return }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(importUrl.trim())
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error()
    } catch {
      setError('Enter a valid recipe URL beginning with http:// or https://.')
      return
    }
    setImporting(true)
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      const importedRecipe = await client.importRecipeFromUrl(parsedUrl.toString())
      setImportUrl('')
      setMessage(`Imported "${importedRecipe.name}".`)
      navigate(`/recipes/${importedRecipe.slug || importedRecipe.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import recipe.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content narrow">
        <div className="page-intro">
          <p className="eyebrow">Bring something new home</p>
          <h1 className="page-intro-title">Import a recipe.</h1>
          <p className="page-intro-text">Paste a recipe URL and add it to your Mealie collection.</p>
        </div>
        {!activeProfile ? (
          <div className="empty-state">
            <p className="empty-state-title">No account connected</p>
            <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
          </div>
        ) : (
          <section className="setup-section">
            <form onSubmit={handleImport} className="form-stack">
              <div className="form-field">
                <label className="form-label" htmlFor="import-page-url">Recipe URL</label>
                <input id="import-page-url" className="form-input" type="url" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://example.com/recipe" required />
              </div>
              {message ? <p className="success-message">{message}</p> : null}
              {error ? <p className="error-message">{error}</p> : null}
              <button type="submit" className="btn-primary" disabled={importing}>{importing ? 'Importing...' : 'Import recipe'}</button>
            </form>
          </section>
        )}
      </main>
    </div>
  )
}

const FINDER_STORAGE_KEY = 'mealie-connect-ingredient-finder'
const FINDER_RESULTS_SHOWN = 60

interface StoredFinderState { have?: string[]; mode?: IngredientMatchMode; ignoreStaples?: boolean }

function readFinderState(): StoredFinderState {
  try { return JSON.parse(window.localStorage.getItem(FINDER_STORAGE_KEY) ?? '{}') as StoredFinderState }
  catch { return {} }
}

/** Lists up to `limit` items, then "and N more". */
function summarizeList(items: string[], limit = 4): string {
  if (items.length <= limit) return items.join(', ')
  return `${items.slice(0, limit).join(', ')} and ${items.length - limit} more`
}

function IngredientFinderPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [have, setHave] = useState<string[]>(() => readFinderState().have ?? [])
  const [mode, setMode] = useState<IngredientMatchMode>(() => readFinderState().mode ?? 'any')
  const [ignoreStaples, setIgnoreStaples] = useState(() => readFinderState().ignoreStaples ?? true)
  const [results, setResults] = useState<IngredientFinderResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const searchRun = useRef<{ cancelled: boolean } | null>(null)

  useEffect(() => {
    try { window.localStorage.setItem(FINDER_STORAGE_KEY, JSON.stringify({ have, mode, ignoreStaples })) }
    catch { /* Remembering the list is a convenience only. */ }
  }, [have, mode, ignoreStaples])

  useEffect(() => () => { if (searchRun.current) searchRun.current.cancelled = true }, [])

  const updateSearch = (update: () => void) => { update(); setResults(null) }

  const find = async () => {
    if (!activeProfile || have.length === 0) return
    if (searchRun.current) searchRun.current.cancelled = true
    const run = { cancelled: false }
    searchRun.current = run
    setSearching(true)
    setError('')
    setProgress(null)
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      const found = await findRecipesByIngredients(client, have, {
        mode,
        ignoreStaples,
        signal: run,
        onProgress: (done, total) => { if (!run.cancelled) setProgress({ done, total }) },
      })
      if (!run.cancelled) setResults(found)
    } catch (err) {
      if (!run.cancelled) setError(err instanceof Error ? err.message : 'Could not search your recipes.')
    } finally {
      if (!run.cancelled) { setSearching(false); setProgress(null) }
    }
  }

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content">
        {!activeProfile ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Refrigerator /></div>
            <p className="empty-state-title">Ingredient Finder</p>
            <p className="empty-state-text">No active Mealie account is connected.</p>
            <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
          </div>
        ) : (
          <>
            <div className="page-intro">
              <p className="eyebrow">Ingredient Finder</p>
              <h1 className="page-intro-title">Cook with what you already have.</h1>
              <p className="page-intro-text">List what's in your fridge, pantry, or freezer and find recipes that use it.</p>
            </div>

            <section className="finder-panel">
              <div className="filter-group">
                <h4>What do you have?</h4>
                <IngredientChipsInput id="finder-ingredient" label="Add an ingredient you have" values={have} onChange={(next) => updateSearch(() => setHave(next))} />
              </div>
              <div className="finder-options">
                <MatchModeToggle mode={mode} onChange={(next) => updateSearch(() => setMode(next))} />
                <label className="finder-checkbox">
                  <input type="checkbox" checked={ignoreStaples} onChange={(event) => updateSearch(() => setIgnoreStaples(event.target.checked))} />
                  <span>Assume I have salt, pepper, oil, and water</span>
                </label>
              </div>
              <p className="finder-hint">
                {mode === 'any' ? 'Shows recipes that use at least one of your ingredients.' : 'Shows only recipes that use every ingredient you listed.'}
              </p>
              <div className="finder-actions">
                <button type="button" className="btn-primary" onClick={() => void find()} disabled={searching || have.length === 0}>
                  <Search /> {searching ? 'Finding recipes...' : 'Find Recipes'}
                </button>
                {have.length > 0 && !searching ? <button type="button" className="btn-ghost btn-sm" onClick={() => updateSearch(() => setHave([]))}>Clear list</button> : null}
              </div>
              {searching && progress && progress.total > 0 ? (
                <p className="finder-progress" aria-live="polite">Checking {progress.done} of {progress.total} recipes...</p>
              ) : null}
            </section>

            <ErrorMessage message={error} activeProfile={activeProfile} />

            {results && !searching ? (
              results.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon"><Refrigerator /></div>
                  <p className="empty-state-title">No recipes match</p>
                  <p className="empty-state-text">{mode === 'all' && have.length > 1 ? 'Try Match ANY, or remove an ingredient.' : 'Try a different ingredient name.'}</p>
                </div>
              ) : (
                <section className="finder-results" aria-label="Matching recipes">
                  <p className="result-count">{results.length} recipe{results.length === 1 ? '' : 's'}{results.length > FINDER_RESULTS_SHOWN ? `, showing the best ${FINDER_RESULTS_SHOWN}` : ''}</p>
                  <ul className="finder-result-list">
                    {results.slice(0, FINDER_RESULTS_SHOWN).map((result) => (
                      <li key={result.recipe.id}>
                        <Link className="finder-result" to={`/recipes/${result.recipe.slug || result.recipe.id}`}>
                          <div className="finder-result-image">
                            <RecipeThumbnail activeProfile={activeProfile} recipe={result.recipe} />
                          </div>
                          <div className="finder-result-body">
                            <div className="finder-result-heading">
                              <h3 className="finder-result-title">{result.recipe.name}</h3>
                              <MatchBadge result={result} />
                            </div>
                            <p className="finder-result-detail">Uses your {summarizeList(result.matched)}</p>
                            {result.missing.length > 0 ? <p className="finder-result-detail muted">You'd also need {summarizeList(result.missing)}</p> : null}
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}

function RecipeThumbnail({ activeProfile, recipe, className = 'recipe-thumbnail', size = 'min-original' }: {
  activeProfile: MealieProfile
  recipe: MealieRecipeSummary
  className?: string
  size?: 'original' | 'min-original'
}) {
  const [imageUrl, setImageUrl] = useState('')
  const [usePlaceholder, setUsePlaceholder] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [visible, setVisible] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const { id: recipeId, image: recipeImage } = recipe

  // Only download the image once it is near the viewport.
  useEffect(() => {
    const element = imageRef.current
    if (!element || visible) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '300px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    const sourceUrl = client.resolveRecipeImage({ id: recipeId, image: recipeImage }, size)
    setLoaded(false)
    setUsePlaceholder(false)
    if (!sourceUrl) { setUsePlaceholder(true); return }
    let disposed = false
    // Some recipes have no resized copy on the server; fall back to the original.
    const fallbackUrl = size === 'original' ? undefined : client.resolveRecipeImage({ id: recipeId, image: recipeImage }, 'original')
    client.loadRecipeImage(sourceUrl)
      .catch((error: unknown) => (fallbackUrl ? client.loadRecipeImage(fallbackUrl) : Promise.reject(error)))
      .then((nextImageUrl) => {
        if (disposed) { URL.revokeObjectURL(nextImageUrl); return }
        setImageUrl(nextImageUrl)
      })
      .catch(() => { if (!disposed) { setImageUrl(''); setUsePlaceholder(true) } })
    return () => {
      disposed = true
      setImageUrl((currentImageUrl) => {
        if (currentImageUrl) URL.revokeObjectURL(currentImageUrl)
        return ''
      })
    }
  }, [activeProfile, recipeId, recipeImage, size, visible])
  const src = imageUrl || (usePlaceholder ? defaultRecipeImage : undefined)
  return (
    <img
      ref={imageRef}
      className={className}
      src={src}
      alt=""
      data-loaded={loaded && Boolean(src) ? 'true' : 'false'}
      onLoad={() => setLoaded(true)}
    />
  )
}

function RecipesPage({ activeProfile, recipes, categories, tags, searchTerm, setSearchTerm, selectedCategories, setSelectedCategories, selectedTags, setSelectedTags, extraFilters, setExtraFilters, ingredientMatches, loading, loadingMore, hasMore, onLoadMore, error }: {
  activeProfile: MealieProfile | null
  recipes: MealieRecipeSummary[]
  categories: MealieCategory[]
  tags: MealieTag[]
  searchTerm: string
  setSearchTerm: (value: string) => void
  selectedCategories: string[]
  setSelectedCategories: (value: string[]) => void
  selectedTags: string[]
  setSelectedTags: (value: string[]) => void
  extraFilters: RecipeExtraFilters
  setExtraFilters: (value: RecipeExtraFilters) => void
  ingredientMatches: Map<string, IngredientFinderResult>
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
  error: string
}) {
  const loadMoreTrigger = useRef<HTMLDivElement>(null)
  const [showBackToTop, setShowBackToTop] = useState(false)

  useEffect(() => {
    const trigger = loadMoreTrigger.current
    if (!trigger || !hasMore) return
    const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) onLoadMore() }, { rootMargin: '480px 0px' })
    observer.observe(trigger)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore])

  useEffect(() => {
    setShowBackToTop(recipes.length >= RECIPES_PAGE_SIZE * 2)
  }, [recipes.length])

  const toggleCategory = (id: string) => {
    setSelectedCategories(selectedCategories.includes(id) ? selectedCategories.filter((value) => value !== id) : [...selectedCategories, id])
  }

  const toggleTag = (id: string) => {
    setSelectedTags(selectedTags.includes(id) ? selectedTags.filter((value) => value !== id) : [...selectedTags, id])
  }

  const activeFilterCount = selectedCategories.length + selectedTags.length
    + (extraFilters.maxPrepTime !== undefined ? 1 : 0) + (extraFilters.maxCookTime !== undefined ? 1 : 0) + extraFilters.ingredients.length
  const clearFilters = () => { setSelectedCategories([]); setSelectedTags([]); setExtraFilters(NO_EXTRA_FILTERS) }
  const updateExtraFilters = (update: Partial<RecipeExtraFilters>) => setExtraFilters({ ...extraFilters, ...update })

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content recipes-page">
        {!activeProfile ? (
          <div className="empty-state">
            <div className="empty-state-icon"><BookOpen /></div>
            <p className="eyebrow">Recipe library</p>
            <p className="empty-state-title">Your recipes are waiting.</p>
            <p className="empty-state-text">No active Mealie account is connected.</p>
            <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
          </div>
        ) : (
          <>
            <div className="page-intro">
              <p className="eyebrow">Recipe library</p>
              <h1 className="page-intro-title">Find something to cook.</h1>
            </div>

            <div className="toolbar">
              <div className="form-search">
                <Search className="form-search-icon" />
                <label className="sr-only" htmlFor="recipe-search">Search your recipes</label>
                <input id="recipe-search" className="form-search-input" type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search recipes by name or ingredient..." />
              </div>
              <span className="result-count">{recipes.length} recipes</span>
            </div>

            <div className="filter-panel">
              <div className="filter-panel-header">
                <span className="filter-panel-title">Filter</span>
                {activeFilterCount > 0 ? (
                  <button type="button" className="btn-ghost btn-sm" onClick={clearFilters}>
                    <X /> Clear {activeFilterCount}
                  </button>
                ) : null}
              </div>

              <div className="filter-group">
                <h4>Categories</h4>
                <label className="sr-only" htmlFor="mobile-category-filter">Category</label>
                <select id="mobile-category-filter" className="filter-select-mobile" value={selectedCategories[0] ?? ''} onChange={(event) => setSelectedCategories(event.target.value ? [event.target.value] : [])}>
                  <option value="">All categories</option>
                  {categories.map((category) => (<option key={category.id} value={category.id}>{category.name}</option>))}
                </select>
                <div className="chip-list">
                  {categories.map((category) => (
                    <button key={category.id} type="button" className={selectedCategories.includes(category.id) ? 'chip active' : 'chip'} onClick={() => toggleCategory(category.id)}>{category.name}</button>
                  ))}
                </div>
              </div>

              <div className="filter-group">
                <h4>Tags</h4>
                <label className="sr-only" htmlFor="mobile-tag-filter">Tag</label>
                <select id="mobile-tag-filter" className="filter-select-mobile" value={selectedTags[0] ?? ''} onChange={(event) => setSelectedTags(event.target.value ? [event.target.value] : [])}>
                  <option value="">All tags</option>
                  {tags.map((tag) => (<option key={tag.id} value={tag.id}>{tag.name}</option>))}
                </select>
                <div className="chip-list">
                  {tags.map((tag) => (
                    <button key={tag.id} type="button" className={selectedTags.includes(tag.id) ? 'chip active' : 'chip'} onClick={() => toggleTag(tag.id)}>{tag.name}</button>
                  ))}
                </div>
              </div>

              <div className="filter-group">
                <h4>Prep time</h4>
                <TimeLimitChips label="Maximum prep time" value={extraFilters.maxPrepTime} onChange={(maxPrepTime) => updateExtraFilters({ maxPrepTime })} />
              </div>

              <div className="filter-group">
                <h4>Cook time</h4>
                <TimeLimitChips label="Maximum cook time" value={extraFilters.maxCookTime} onChange={(maxCookTime) => updateExtraFilters({ maxCookTime })} />
              </div>

              <div className="filter-group">
                <h4>Ingredients</h4>
                <IngredientChipsInput id="recipe-ingredient-filter" label="Filter by an ingredient" values={extraFilters.ingredients} onChange={(ingredients) => updateExtraFilters({ ingredients })} />
                {extraFilters.ingredients.length > 1 ? <MatchModeToggle mode={extraFilters.ingredientMode} onChange={(ingredientMode) => updateExtraFilters({ ingredientMode })} /> : null}
                <Link className="filter-link" to="/ingredients">Find recipes for everything in your fridge <ChevronRight /></Link>
              </div>
            </div>

            {loading ? <p style={{padding: 'var(--sp-4) 0', color: 'var(--text-muted)'}}>{extraFilters.ingredients.length > 0 ? 'Checking recipe ingredients...' : 'Loading recipes...'}</p> : null}
            <ErrorMessage message={error} activeProfile={activeProfile} />

            <div className="recipe-grid">
              {recipes.map((recipe) => (
                <article key={recipe.id} className="recipe-card">
                    <Link to={`/recipes/${recipe.slug || recipe.id}`}>
                    <div className="recipe-card-image-wrap">
                      <RecipeThumbnail activeProfile={activeProfile} recipe={recipe} />
                    </div>
                    <div className="recipe-card-body">
                      <p className="recipe-card-kicker">{recipe.categories?.[0]?.name ?? 'Recipe'}</p>
                      <h3 className="recipe-card-title">{recipe.name}</h3>
                      {ingredientMatches.has(recipe.id) ? <MatchBadge result={ingredientMatches.get(recipe.id) as IngredientFinderResult} /> : null}
                      {(extraFilters.maxPrepTime !== undefined || extraFilters.maxCookTime !== undefined) && (recipe.prepTime || recipe.cookTime) ? (
                        <p className="recipe-card-meta">{[recipe.prepTime ? `${formatMealieTime(recipe.prepTime)} prep` : '', recipe.cookTime ? `${formatMealieTime(recipe.cookTime)} cook` : ''].filter(Boolean).join(' · ')}</p>
                      ) : recipe.description ? <p className="recipe-card-meta">{recipe.description}</p> : null}
                    </div>
                  </Link>
                </article>
              ))}
            </div>

            {hasMore ? (
              <div ref={loadMoreTrigger} className="load-more-trigger" aria-live="polite">
                {loadingMore ? 'Loading more recipes...' : 'Scroll for more'}
              </div>
            ) : null}

            {showBackToTop ? (
              <button type="button" className="back-to-top" aria-label="Back to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                Back to Top
              </button>
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}

/** Servings stepper. With known base servings it steps by one serving;
 * otherwise it steps the multiplier by ½. */
function ServingsScaler({ baseServings, scale, onChange }: {
  baseServings?: number
  scale: number
  onChange: (scale: number) => void
}) {
  const servings = baseServings ? Math.round(baseServings * scale * 100) / 100 : undefined
  const decrease = () => {
    if (baseServings && servings !== undefined) onChange(Math.max(1, servings - 1) / baseServings)
    else onChange(Math.max(0.5, scale - 0.5))
  }
  const increase = () => {
    if (baseServings && servings !== undefined) onChange((servings + 1) / baseServings)
    else onChange(scale + 0.5)
  }
  const atMinimum = baseServings ? (servings ?? 1) <= 1 : scale <= 0.5
  return (
    <div className="servings-scaler" role="group" aria-label="Adjust servings">
      <button type="button" className="servings-scaler-btn" onClick={decrease} disabled={atMinimum} aria-label="Fewer servings"><Minus /></button>
      <span className="servings-scaler-value" aria-live="polite">
        {servings !== undefined ? `${formatQuantity(servings)} serving${servings === 1 ? '' : 's'}` : `×${formatQuantity(scale)}`}
      </span>
      <button type="button" className="servings-scaler-btn" onClick={increase} aria-label="More servings"><Plus /></button>
      {scale !== 1 ? <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(1)}>Reset</button> : null}
    </div>
  )
}

/** Ingredient list with section headings and tap-to-check-off. */
function IngredientChecklist({ ingredients, scale, checked, onToggle }: {
  ingredients: MealieIngredient[]
  scale: number
  checked: Set<number>
  onToggle: (index: number) => void
}) {
  if (ingredients.length === 0) return <ul className="ingredient-list"><li className="ingredient-item">No ingredients listed.</li></ul>
  return (
    <ul className="ingredient-list">
      {ingredients.map((ingredient, index) => (
        <li key={`${ingredient.id ?? 'ingredient'}-${index}`} className="ingredient-entry">
          {ingredient.title ? <p className="ingredient-section-title">{ingredient.title}</p> : null}
          <label className={checked.has(index) ? 'ingredient-item ingredient-check checked' : 'ingredient-item ingredient-check'}>
            <input type="checkbox" checked={checked.has(index)} onChange={() => onToggle(index)} />
            <span>{scaleIngredientText(ingredient, scale)}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}

function useCheckedSet(resetKey: unknown) {
  const [checked, setChecked] = useState<Set<number>>(() => new Set())
  useEffect(() => { setChecked(new Set()) }, [resetKey])
  const toggle = useCallback((index: number) => {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])
  return [checked, toggle] as const
}

function parseScaleParam(search: string): number {
  const value = Number.parseFloat(new URLSearchParams(search).get('scale') ?? '')
  return Number.isFinite(value) && value > 0 && value <= 50 ? value : 1
}

function RecipeDetailPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { slug } = useParams()
  const location = useLocation()
  const [recipe, setRecipe] = useState<MealieRecipeDetail | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showShoppingModal, setShowShoppingModal] = useState(false)
  const [showMealPlanModal, setShowMealPlanModal] = useState(false)
  const [scale, setScale] = useState(() => parseScaleParam(location.search))
  const [checkedIngredients, toggleIngredient] = useCheckedSet(slug)

  useEffect(() => {
    if (!activeProfile || !slug) { setRecipe(null); return }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')
    setImageUrl('')
    client.getRecipe(slug).then(async (nextRecipe) => {
      setRecipe(nextRecipe)
      if (nextRecipe.image) {
        try { setImageUrl(await client.loadRecipeImage(nextRecipe.image)) }
        catch { setImageUrl('') }
      }
    }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false))
    return () => {
      setImageUrl((currentImageUrl) => {
        if (currentImageUrl) URL.revokeObjectURL(currentImageUrl)
        return ''
      })
    }
  }, [activeProfile, slug])

  const steps = recipe ? normalizeInstructionSteps(recipe) : []
  const ingredients = recipe?.ingredients ?? []
  const notes = recipe?.notes ?? []
  const scalable = ingredients.some(canScaleIngredient)
  const cookPath = recipe ? `/cook/${recipe.slug || recipe.id}${scale !== 1 ? `?scale=${scale}` : ''}` : ''

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content">
        <div className="sticky-back-bar">
          <Link className="btn-ghost btn-sm" to="/recipes"><ChevronLeft /> Recipes</Link>
        {recipe ? <Link className="btn-primary btn-sm" to={cookPath}><Utensils /> Cook this</Link> : null}
        </div>

        {loading ? <p style={{color:'var(--text-muted)', padding:'var(--sp-8) 0'}}>Loading recipe...</p> : null}
        <ErrorMessage message={error} activeProfile={activeProfile} />
        {!recipe && !loading && !error ? <p className="empty-state-text">No recipe found.</p> : null}

        {recipe ? (
          <>
            <div className="detail-hero-wrap">
              <img className="detail-hero-image" src={imageUrl || defaultRecipeImage} alt={imageUrl ? recipe.name : ''} />
              <div className="detail-hero-gradient" aria-hidden="true" />
              <div className="detail-header">
                <p className="eyebrow">{recipe.categories?.[0]?.name ?? 'Recipe'}</p>
                <h1 className="detail-title">{recipe.name}</h1>
                {recipe.description ? <p className="detail-description">{recipe.description}</p> : null}
                <div className="detail-meta-row">
                  {recipe.totalTime ? <span className="detail-meta-item">{formatMealieTime(recipe.totalTime)} total</span> : null}
                  {recipe.prepTime ? <span className="detail-meta-item">{formatMealieTime(recipe.prepTime)} prep</span> : null}
                  {recipe.cookTime ? <span className="detail-meta-item">{formatMealieTime(recipe.cookTime)} cook</span> : null}
                  {recipe.servings ? <span className="detail-meta-item">{recipe.servings} servings</span> : null}
                </div>
                {recipe.url ? <ExternalLink className="btn-ghost btn-sm" href={recipe.url}>Open original source</ExternalLink> : null}
                <div className="detail-actions">
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setShowShoppingModal(true)}>Add to Shopping List</button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setShowMealPlanModal(true)}>Add to Meal Plan</button>
                </div>
              </div>
            </div>

            <div className="detail-layout">
              <aside>
                <div className="section-header">
                  <h2 className="detail-ingredients-heading">Ingredients</h2>
                </div>
                {scalable ? <ServingsScaler baseServings={recipe.servings} scale={scale} onChange={setScale} /> : null}
                <IngredientChecklist ingredients={ingredients} scale={scale} checked={checkedIngredients} onToggle={toggleIngredient} />
              </aside>

              <section className="detail-content">
                <h2 className="instructions-heading">Instructions</h2>
                <ol className="instructions-list">
                  {steps.length > 0 ? steps.map((step, index) => (
                    <li key={`${step.id ?? "step"}-${index}`} className="instruction-step">
                      <span className="step-number">{index + 1}</span>
                      <div>
                        {step.title ? <h3 className="step-title">{step.title}</h3> : null}
                        <p className="step-text">{step.text ?? step.instruction ?? `Step ${index + 1}`}</p>
                      </div>
                    </li>
                  )) : <li className="instruction-step"><p className="step-text">No instructions available.</p></li>}
                </ol>

                {notes.length > 0 ? (
                  <div className="recipe-notes">
                    <h2 className="instructions-heading">Notes</h2>
                    {notes.map((note, index) => (
                      <div key={`note-${index}`} className="recipe-note">
                        {note.title ? <h3 className="step-title">{note.title}</h3> : null}
                        {note.text ? <p className="step-text">{note.text}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          </>
        ) : null}

        {recipe && showShoppingModal && activeProfile ? (
          <AddIngredientsToShoppingListModal activeProfile={activeProfile} recipeId={recipe.id} recipeName={recipe.name} scale={scale} onClose={() => setShowShoppingModal(false)} />
        ) : null}
        {recipe && showMealPlanModal && activeProfile ? (
          <AddToMealPlanModal activeProfile={activeProfile} recipe={recipe} onClose={() => setShowMealPlanModal(false)} />
        ) : null}
      </main>
    </div>
  )
}

/** Keeps the screen on while cooking: the native plugin in the Android app,
 * the Screen Wake Lock API in browsers that support it. */
function useKeepScreenAwake(): void {
  useEffect(() => {
    if (isNativePlatform()) {
      void KeepAwake.keepAwake()
      return () => { void KeepAwake.allowSleep() }
    }
    if (!('wakeLock' in navigator)) return
    let sentinel: WakeLockSentinel | undefined
    let disposed = false
    const acquire = async () => {
      try {
        const next = await navigator.wakeLock.request('screen')
        if (disposed) { void next.release(); return }
        sentinel = next
      } catch {
        // Denied (e.g. low battery); cooking still works without it.
      }
    }
    // The browser releases the lock when the tab is hidden; re-acquire on return.
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void acquire() }
    void acquire()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      void sentinel?.release()
    }
  }, [])
}

const SWIPE_THRESHOLD_PX = 60

function CookModePage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { slug } = useParams()
  const location = useLocation()
  const scale = parseScaleParam(location.search)
  const [recipe, setRecipe] = useState<MealieRecipeDetail | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [finished, setFinished] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showIngredients, setShowIngredients] = useState(false)
  const [checkedIngredients, toggleIngredient] = useCheckedSet(slug)
  const [markState, setMarkState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [markError, setMarkError] = useState('')
  const touchStartX = useRef<number | null>(null)
  const { timers, now, start: startTimer, togglePause, dismiss } = useCookTimers()

  useEffect(() => {
    if (!activeProfile || !slug) { setRecipe(null); return }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')
    client.getRecipe(slug).then((nextRecipe) => { setRecipe(nextRecipe); setCurrentStep(0); setFinished(false) }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false))
  }, [activeProfile, slug])

  useKeepScreenAwake()

  const steps = recipe ? normalizeInstructionSteps(recipe) : []
  const current = steps[currentStep]
  const isLastStep = currentStep >= steps.length - 1

  const goPrevious = useCallback(() => {
    if (finished) { setFinished(false); return }
    setCurrentStep((value) => Math.max(0, value - 1))
  }, [finished])
  const goNext = useCallback(() => {
    if (isLastStep) { setFinished(true); return }
    setCurrentStep((value) => Math.min(steps.length - 1, value + 1))
  }, [isLastStep, steps.length])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'ArrowRight') goNext()
      if (event.key === 'ArrowLeft') goPrevious()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [goNext, goPrevious])

  const onTouchStart = (event: React.TouchEvent) => { touchStartX.current = event.touches[0]?.clientX ?? null }
  const onTouchEnd = (event: React.TouchEvent) => {
    const startX = touchStartX.current
    touchStartX.current = null
    const endX = event.changedTouches[0]?.clientX
    if (startX === null || endX === undefined) return
    const delta = endX - startX
    if (delta <= -SWIPE_THRESHOLD_PX) goNext()
    if (delta >= SWIPE_THRESHOLD_PX) goPrevious()
  }

  const markMade = async () => {
    if (!activeProfile || !recipe) return
    setMarkState('saving')
    setMarkError('')
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      const who = activeProfile.displayName ?? activeProfile.username ?? 'Someone'
      await client.markRecipeMade({ id: recipe.id, slug: recipe.slug || recipe.id }, `${who} made this`)
      setMarkState('saved')
    } catch (err) {
      setMarkState('idle')
      setMarkError(err instanceof Error ? err.message : 'Could not record that you made this.')
    }
  }

  const recipePath = recipe ? `/recipes/${recipe.slug || recipe.id}${scale !== 1 ? `?scale=${scale}` : ''}` : '/recipes'
  const ingredients = recipe?.ingredients ?? []

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content narrow">
        <div className="sticky-back-bar">
          <Link className="btn-ghost btn-sm" to={recipePath}>
            <ChevronLeft /> Return to recipe
          </Link>
          {recipe && ingredients.length > 0 ? (
            <button type="button" className={showIngredients ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setShowIngredients((value) => !value)} aria-expanded={showIngredients}>
              <ListChecks /> Ingredients
            </button>
          ) : null}
        </div>

        {loading ? <p style={{color:'var(--text-muted)', padding:'var(--sp-8) 0'}}>Loading cook mode...</p> : null}
        <ErrorMessage message={error} activeProfile={activeProfile} />

        <TimerTray timers={timers} now={now} onTogglePause={togglePause} onDismiss={dismiss} />

        {recipe && showIngredients ? (
          <section className="cook-ingredients-panel" aria-label="Ingredients">
            {scale !== 1 ? <p className="cook-ingredients-scale">Scaled ×{formatQuantity(scale)}</p> : null}
            <IngredientChecklist ingredients={ingredients} scale={scale} checked={checkedIngredients} onToggle={toggleIngredient} />
          </section>
        ) : null}

        {recipe && finished ? (
          <div className="cook-content">
            <p className="eyebrow cook-recipe-name">{recipe.name}</p>
            <div className="cook-step-card cook-finished-card">
              <p className="cook-finished-title">Nice work!</p>
              <p className="step-text">You've reached the end of the recipe.</p>
              <div className="cook-finished-actions">
                {markState === 'saved' ? (
                  <p className="success-message">Added to the recipe's timeline in Mealie.</p>
                ) : (
                  <button type="button" className="btn-primary" onClick={() => void markMade()} disabled={markState === 'saving'}>
                    <Check /> {markState === 'saving' ? 'Saving...' : 'I made this'}
                  </button>
                )}
                {markError ? <p className="error-message">{markError}</p> : null}
                <Link className="btn-secondary" to={recipePath}>Back to recipe</Link>
                <button type="button" className="btn-ghost" onClick={() => { setCurrentStep(0); setFinished(false) }}>Start over</button>
              </div>
            </div>
            <div className="cook-actions">
              <button type="button" className="btn-secondary" onClick={goPrevious}>
                <ChevronLeft /> Last step
              </button>
            </div>
          </div>
        ) : null}

        {recipe && current && !finished ? (
          <div className="cook-content">
            <p className="eyebrow cook-recipe-name">{recipe.name}</p>
            <p className="cook-step-label">Step {currentStep + 1} of {steps.length}</p>
            <div className="cook-progress">
              <div className="cook-progress-fill" style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }} />
            </div>
            <div className="cook-step-card" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
              <span className="step-number">{currentStep + 1}</span>
              {current.title ? <h2 className="step-title">{current.title}</h2> : null}
              <p className="step-text">{current.text ?? current.instruction ?? `Step ${currentStep + 1}`}</p>
              <StepTimerButtons
                key={currentStep}
                stepText={current.text ?? current.instruction ?? ''}
                stepLabel={`Step ${currentStep + 1}`}
                onStart={startTimer}
              />
            </div>
            <div className="cook-actions">
              <button type="button" className="btn-secondary" onClick={goPrevious} disabled={currentStep === 0}>
                <ChevronLeft /> Previous
              </button>
              <button type="button" className="btn-primary" onClick={goNext}>
                {isLastStep ? <>Finish <Check /></> : <>Next <ChevronRight /></>}
              </button>
            </div>
            <p className="cook-hint">Swipe or use the arrow keys to move between steps.</p>
          </div>
        ) : null}
      </main>
    </div>
  )
}

function ShoppingListsPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [lists, setLists] = useState<MealieShoppingList[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [newListName, setNewListName] = useState('')

  useEffect(() => {
    if (!activeProfile) { setLists([]); return }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')
    client.getShoppingLists().then((nextLists) => setLists(nextLists)).catch((err: Error) => setError(err.message)).finally(() => setLoading(false))
  }, [activeProfile])

  const createNewList = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeProfile || !newListName.trim()) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    try {
      const newList = await client.createShoppingList(newListName)
      setLists([...lists, newList])
      setNewListName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create list.')
    }
  }

  const deleteList = async (id: string) => {
    if (!activeProfile) return
    const listName = lists.find((list) => list.id === id)?.name ?? 'this list'
    if (!window.confirm(`Delete "${listName}" and all of its items? This cannot be undone.`)) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    try {
      await client.deleteShoppingList(id)
      setLists(lists.filter((list) => list.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete list.')
    }
  }

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content">
        {!activeProfile ? (
          <div className="empty-state">
            <div className="empty-state-icon"><ShoppingCart /></div>
            <p className="empty-state-title">Shopping lists</p>
            <p className="empty-state-text">No active Mealie account is connected.</p>
            <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
          </div>
        ) : (
          <>
            <div className="page-intro">
              <p className="eyebrow">Shopping lists</p>
              <h1 className="page-intro-title">Bring the ingredients together.</h1>
            </div>

            <section className="setup-section">
              <form onSubmit={createNewList} className="form-stack">
                <div className="form-row">
                  <div className="form-field" style={{flex:1}}>
                    <label className="form-label" htmlFor="new-list-name">New list name</label>
                    <input id="new-list-name" className="form-input" type="text" value={newListName} onChange={(event) => setNewListName(event.target.value)} placeholder="Grocery shopping, Dinner party, etc." />
                  </div>
                  <button type="submit" className="btn-primary" style={{alignSelf:'flex-end'}}>Create</button>
                </div>
              </form>
            </section>

            {error ? <p className="error-message">{error}</p> : null}
            {loading ? <p style={{color:'var(--text-muted)'}}>Loading shopping lists...</p> : null}

            {lists.length === 0 && !loading ? (
              <div className="empty-state">
                <div className="empty-state-icon"><ShoppingCart /></div>
                <p className="empty-state-title">No shopping lists yet</p>
                <p className="empty-state-text">Create one to get started.</p>
              </div>
            ) : (
              <div className="shopping-list-grid">
                {lists.map((list) => (
                  <div key={list.id} className="shopping-list-card">
                    <p className="shopping-list-card-name">{list.name}</p>
                    <p className="shopping-list-card-count">{(list.items ?? []).length} items</p>
                    <div className="shopping-list-card-actions">
              <Link className="btn-secondary btn-sm" to={`/shopping/${list.id}`}>Open</Link>
                      <button type="button" onClick={() => deleteList(list.id)} className="btn-ghost btn-sm" style={{color:'var(--danger)'}}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

/** Mealie returns an item's food as an object; older data may hold a string. */
function shoppingItemFoodName(item: MealieShoppingListItem): string | undefined {
  const food = item.food as unknown
  if (typeof food === 'string') return food || undefined
  return (food as { name?: string } | null | undefined)?.name || undefined
}

function shoppingItemQuantity(item: MealieShoppingListItem): number {
  const value = typeof item.quantity === 'string' ? Number.parseFloat(item.quantity) : item.quantity
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function ShoppingItemRow({ item, onToggle, onRemove, onSave }: {
  item: MealieShoppingListItem
  onToggle: () => void
  onRemove: () => void
  onSave: (updates: { quantity: number; note: string }) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const foodName = shoppingItemFoodName(item)
  const label = item.display || `${item.quantity ?? ''} ${item.note ?? ''}`.trim()

  const startEditing = () => {
    const current = shoppingItemQuantity(item)
    setQuantity(current ? String(current) : '')
    setNote(item.note ?? '')
    setError('')
    setEditing(true)
  }

  const parseQuantity = (value: string) => (value.trim() === '' ? 0 : Number.parseFloat(value.replace(',', '.')))
  const parsedQuantity = parseQuantity(quantity)
  const stepQuantity = (delta: number) => setQuantity((current) => {
    const base = parseQuantity(current)
    return String(Math.max(0, Math.round(((Number.isFinite(base) ? base : 0) + delta) * 100) / 100))
  })

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) { setError('Enter a quantity of 0 or more.'); return }
    if (!foodName && !note.trim()) { setError('Enter what to buy.'); return }
    setSaving(true)
    setError('')
    const saved = await onSave({ quantity: parsedQuantity, note: note.trim() })
    setSaving(false)
    if (saved) setEditing(false)
  }

  if (editing) {
    return (
      <li className="shopping-item editing">
        <form className="shopping-item-editor" onSubmit={save}>
          {foodName ? <p className="shopping-item-editor-food">{foodName}</p> : null}
          <div className="shopping-item-editor-fields">
            <div className="form-field">
              <span className="form-label" id={`qty-label-${item.id}`}>Quantity</span>
              <div className="quantity-stepper" role="group" aria-labelledby={`qty-label-${item.id}`}>
                <button type="button" className="servings-scaler-btn" onClick={() => stepQuantity(-1)} disabled={!(parsedQuantity > 0)} aria-label="Decrease quantity"><Minus /></button>
                <input className="form-input quantity-stepper-input" type="text" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} aria-labelledby={`qty-label-${item.id}`} placeholder="0" />
                <button type="button" className="servings-scaler-btn" onClick={() => stepQuantity(1)} aria-label="Increase quantity"><Plus /></button>
              </div>
            </div>
            <div className="form-field shopping-item-editor-note">
              <label className="form-label" htmlFor={`note-${item.id}`}>{foodName ? 'Note' : 'Item'}</label>
              <input id={`note-${item.id}`} className="form-input" type="text" value={note} onChange={(event) => setNote(event.target.value)} placeholder={foodName ? 'Optional' : 'What to buy'} />
            </div>
          </div>
          {error ? <p className="error-message">{error}</p> : null}
          <div className="shopping-item-editor-actions">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn-primary btn-sm" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className={item.checked ? 'shopping-item checked' : 'shopping-item'}>
      <input className="shopping-item-checkbox" type="checkbox" checked={item.checked ?? false} onChange={onToggle} aria-label={`Mark ${label || 'item'} as done`} />
      <button type="button" className="shopping-item-text shopping-item-edit-trigger" onClick={startEditing} aria-label={`Edit ${label || 'item'}`}>{label}</button>
      <button type="button" className="shopping-item-remove btn-ghost btn-sm" onClick={startEditing} aria-label="Edit quantity">
        <Pencil />
      </button>
      <button type="button" className="shopping-item-remove btn-ghost btn-sm" onClick={onRemove} aria-label="Remove item">
        <X />
      </button>
    </li>
  )
}

function ShoppingListDetailPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { id } = useParams()
  const [list, setList] = useState<MealieShoppingList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [newItemQuantity, setNewItemQuantity] = useState('')
  const [newItemUnit, setNewItemUnit] = useState('')
  const [newItemFood, setNewItemFood] = useState('')

  useEffect(() => {
    if (!activeProfile || !id) { setList(null); return }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')
    client.getShoppingList(id).then((nextList) => setList(nextList)).catch((err: Error) => setError(err.message)).finally(() => setLoading(false))
  }, [activeProfile, id])

  const addItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeProfile || !list || !newItemFood.trim()) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    try {
      const updated = await client.addToShoppingList(list.id, { quantity: newItemQuantity || undefined, unit: newItemUnit || undefined, food: newItemFood })
      setList(updated)
      setNewItemQuantity('')
      setNewItemUnit('')
      setNewItemFood('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add item.')
    }
  }

  const toggleItem = async (item: MealieShoppingListItem) => {
    if (!activeProfile || !list || !item.id) return
    const nextChecked = !(item.checked ?? false)
    const setChecked = (checked: boolean) => setList((current) => current
      ? { ...current, items: current.items?.map((candidate) => (candidate.id === item.id ? { ...candidate, checked } : candidate)) }
      : current)
    // Update the checkbox immediately; roll back if Mealie rejects the change.
    setChecked(nextChecked)
    setError('')
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    try {
      await client.updateShoppingListItem(list.id, item, { checked: nextChecked })
    } catch (err) {
      setChecked(!nextChecked)
      setError(err instanceof Error ? err.message : 'Failed to update item.')
    }
  }

  const saveItem = async (item: MealieShoppingListItem, updates: { quantity: number; note: string }): Promise<boolean> => {
    if (!activeProfile || !list) return false
    setError('')
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    try {
      setList(await client.updateShoppingListItem(list.id, item, updates))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update item.')
      return false
    }
  }

  const removeItem = async (itemId: string | undefined) => {
    if (!activeProfile || !list || !itemId) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    try {
      await client.removeFromShoppingList(list.id, itemId)
      setList({ ...list, items: list.items?.filter((item) => item.id !== itemId) })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove item.')
    }
  }

  const removeAllItems = async () => {
    if (!activeProfile || !list) return
    const itemIds = (list.items ?? []).map((item) => item.id).filter((itemId): itemId is string => Boolean(itemId))
    if (itemIds.length === 0) return
    if (!window.confirm(`Remove all ${itemIds.length} items from "${list.name}"?`)) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setError('')
    try {
      const updated = await client.removeAllFromShoppingList(list.id, itemIds)
      setList(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove all items.')
    }
  }

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content narrow">
        <div className="sticky-back-bar">
          <Link className="btn-ghost btn-sm" to="/shopping"><ChevronLeft /> Lists</Link>
        </div>

        {loading ? <p style={{color:'var(--text-muted)', padding:'var(--sp-8) 0'}}>Loading shopping list...</p> : null}
        {error ? <p className="error-message">{error}</p> : null}
        {!list && !loading && !error ? <p className="empty-state-text">No list found.</p> : null}

        {list ? (
          <>
            <div className="page-intro">
              <p className="eyebrow">Shopping list</p>
              <h1 className="page-intro-title">{list.name}</h1>
            </div>

            <section className="shopping-add-form">
              <form onSubmit={addItem} className="form-stack">
                <div className="form-row">
                  <div className="form-field">
                    <label className="form-label" htmlFor="item-qty">Qty</label>
                    <input id="item-qty" className="form-input" type="text" value={newItemQuantity} onChange={(event) => setNewItemQuantity(event.target.value)} placeholder="2" />
                  </div>
                  <div className="form-field">
                    <label className="form-label" htmlFor="item-unit">Unit</label>
                    <input id="item-unit" className="form-input" type="text" value={newItemUnit} onChange={(event) => setNewItemUnit(event.target.value)} placeholder="cups" />
                  </div>
                  <div className="form-field" style={{flex:2}}>
                    <label className="form-label" htmlFor="item-food">Item</label>
                    <input id="item-food" className="form-input" type="text" value={newItemFood} onChange={(event) => setNewItemFood(event.target.value)} placeholder="Flour" />
                  </div>
                  <button type="submit" className="btn-primary" style={{alignSelf:'flex-end'}}><Plus /></button>
                </div>
              </form>
            </section>

            <div className="section-header">
              <div>
                <p className="eyebrow">{(list.items ?? []).length} items</p>
                <h2 className="section-title">Items</h2>
              </div>
              {(list.items ?? []).length > 0 ? (
                <button type="button" className="btn-ghost btn-sm" style={{color:'var(--danger)'}} onClick={() => void removeAllItems()}>Remove all</button>
              ) : null}
            </div>

            <ul className="shopping-items-list">
              {(list.items ?? []).length > 0 ? (
                (list.items ?? []).map((item, index) => (
                  <ShoppingItemRow
                    key={`${item.id ?? 'item'}-${index}`}
                    item={item}
                    onToggle={() => void toggleItem(item)}
                    onRemove={() => void removeItem(item.id)}
                    onSave={(updates) => saveItem(item, updates)}
                  />
                ))
              ) : (
                <li className="empty-state-text" style={{padding:'var(--sp-4)'}}>No items in this list.</li>
              )}
            </ul>
          </>
        ) : null}
      </main>
    </div>
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Formats a date as YYYY-MM-DD in the user's local time zone. (Using
 * toISOString would convert to UTC and can shift the date by a day.) */
function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year as number, ((month as number) ?? 1) - 1, (day as number) ?? 1)
}

function startOfWeek(date: Date): Date {
  const result = new Date(date)
  const day = result.getDay()
  result.setDate(result.getDate() - day)
  result.setHours(0, 0, 0, 0)
  return result
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

type MealPlanView = 'day' | 'week' | 'month'
const MEAL_PLAN_VIEW_KEY = 'mealie-connect-meal-plan-view'

function getStoredMealPlanView(): MealPlanView {
  if (typeof window === 'undefined') return 'week'
  const stored = window.localStorage.getItem(MEAL_PLAN_VIEW_KEY)
  return stored === 'day' || stored === 'week' || stored === 'month' ? stored : 'week'
}

/** What to put in a meal-plan slot: a recipe, or a title typed in by hand
 * (for leftovers, eating out, or a quick side that has no recipe). */
type MealPlanEntryChoice =
  | { mealType: PlannableMealType; recipe: MealieRecipeSummary }
  | { mealType: PlannableMealType; title: string; text: string }

interface MealPlanTarget {
  date: string
  mealType: PlannableMealType
  replaceEntryId?: string
}

function MealPlanPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [view, setView] = useState<MealPlanView>(() => getStoredMealPlanView())
  const [anchorDate, setAnchorDate] = useState(() => new Date())
  const [entries, setEntries] = useState<MealieWeekPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pickerTarget, setPickerTarget] = useState<MealPlanTarget | null>(null)

  useEffect(() => {
    window.localStorage.setItem(MEAL_PLAN_VIEW_KEY, view)
  }, [view])

  const { rangeStart, rangeEnd } = useMemo(() => {
    if (view === 'day') return { rangeStart: new Date(anchorDate), rangeEnd: new Date(anchorDate) }
    if (view === 'week') {
      const start = startOfWeek(anchorDate)
      const end = new Date(start.getTime() + 6 * DAY_MS)
      return { rangeStart: start, rangeEnd: end }
    }
    const start = startOfMonth(anchorDate)
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0)
    return { rangeStart: start, rangeEnd: end }
  }, [view, anchorDate])

  const loadEntries = useCallback(() => {
    if (!activeProfile) { setEntries([]); return }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')
    client.getMealPlans(toDateKey(rangeStart), toDateKey(rangeEnd)).then((nextEntries) => setEntries(nextEntries)).catch((err: Error) => setError(err.message)).finally(() => setLoading(false))
  }, [activeProfile, rangeStart, rangeEnd])

  useEffect(() => { loadEntries() }, [loadEntries])

  const slots = useMemo(() => groupMealPlanEntriesIntoSlots(entries), [entries])

  const slotsFor = useCallback(
    (dateKey: string, mealType: PlannableMealType) => slots.find((slot) => slot.date === dateKey && slot.entryType === mealType)?.entries ?? [],
    [slots],
  )

  const removeEntry = async (entryId: string) => {
    if (!activeProfile) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setError('')
    try {
      await client.deleteMealPlanEntry(entryId)
      setEntries((current) => current.filter((entry) => entry.id !== entryId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove that meal from the meal plan.')
    }
  }

  const addEntryToSlot = async (target: MealPlanTarget, choice: MealPlanEntryChoice) => {
    if (!activeProfile) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setError('')
    try {
      // Create the new entry before deleting the old one so a failure never
      // leaves the slot empty.
      const created = await client.createMealPlanEntry('recipe' in choice
        ? { date: target.date, entryType: choice.mealType, title: choice.recipe.name, recipeId: choice.recipe.id }
        : { date: target.date, entryType: choice.mealType, title: choice.title, text: choice.text })
      setEntries((current) => [...current, created])
      if (target.replaceEntryId) {
        await client.deleteMealPlanEntry(target.replaceEntryId)
        setEntries((current) => current.filter((entry) => entry.id !== target.replaceEntryId))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add that to the meal plan.')
    } finally {
      setPickerTarget(null)
    }
  }

  const goToday = () => setAnchorDate(new Date())
  const goPrevious = () => setAnchorDate((current) => {
    if (view === 'day') return new Date(current.getTime() - DAY_MS)
    if (view === 'week') return new Date(current.getTime() - 7 * DAY_MS)
    return new Date(current.getFullYear(), current.getMonth() - 1, 1)
  })
  const goNext = () => setAnchorDate((current) => {
    if (view === 'day') return new Date(current.getTime() + DAY_MS)
    if (view === 'week') return new Date(current.getTime() + 7 * DAY_MS)
    return new Date(current.getFullYear(), current.getMonth() + 1, 1)
  })

  const openDay = (date: string) => { setAnchorDate(parseDateKey(date)); setView('day') }

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content">
        {!activeProfile ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Calendar /></div>
            <p className="empty-state-title">Meal planning</p>
            <p className="empty-state-text">No active Mealie account is connected.</p>
            <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
          </div>
        ) : (
          <>
            <div className="page-intro">
              <p className="eyebrow">Meal planning</p>
              <h1 className="page-intro-title">Plan the week with less guesswork.</h1>
            </div>

            <div className="meal-plan-toolbar">
              <div className="view-switcher" role="tablist" aria-label="Meal plan view">
                {(['day', 'week', 'month'] as MealPlanView[]).map((viewOption) => (
                  <button key={viewOption} type="button" role="tab" aria-selected={view === viewOption} className={view === viewOption ? 'view-switcher-btn active' : 'view-switcher-btn'} onClick={() => setView(viewOption)}>
                    {viewOption === 'day' ? 'Day' : viewOption === 'week' ? 'Week' : 'Month'}
                  </button>
                ))}
              </div>
              <div className="date-nav">
                <button type="button" className="btn-ghost btn-sm" onClick={goPrevious} aria-label={`Previous ${view}`}><ChevronLeft /></button>
                <button type="button" className="btn-ghost btn-sm" onClick={goToday}>Today</button>
                <button type="button" className="btn-ghost btn-sm" onClick={goNext} aria-label={`Next ${view}`}><ChevronRight /></button>
              </div>
            </div>

            {error ? <p className="error-message">{error}</p> : null}
            {loading ? <p style={{color:'var(--text-muted)'}}>Loading meal plans...</p> : null}

            {view === 'day' ? (
              <MealPlanDayView date={anchorDate} slotsFor={slotsFor} onAdd={setPickerTarget} onRemove={removeEntry} />
            ) : null}
            {view === 'week' ? (
              <MealPlanWeekView weekStart={rangeStart} slotsFor={slotsFor} onAdd={setPickerTarget} onRemove={removeEntry} onOpenDay={openDay} />
            ) : null}
            {view === 'month' ? (
              <MealPlanMonthView monthStart={rangeStart} slots={slots} onOpenDay={openDay} />
            ) : null}
          </>
        )}

        {pickerTarget && activeProfile ? (
          <MealPlanEntryModal
            activeProfile={activeProfile}
            target={pickerTarget}
            onSelect={(choice) => void addEntryToSlot(pickerTarget, choice)}
            onClose={() => setPickerTarget(null)}
          />
        ) : null}
      </main>
    </div>
  )
}

function MealSlotCard({ mealType, entries, onAdd, onRemove, onReplace }: {
  mealType: PlannableMealType
  entries: MealieWeekPlan[]
  onAdd: () => void
  onRemove: (entryId: string) => void
  onReplace: (entry: MealieWeekPlan) => void
}) {
  return (
    <div className="meal-slot-card">
      <h4 className="meal-slot-heading">{MEAL_TYPE_LABELS[mealType]}</h4>
      {entries.length === 0 ? <p className="meal-slot-empty">Nothing planned.</p> : null}
      <ul className="meal-slot-recipe-list">
        {entries.map((entry) => (
          <li key={entry.id} className="meal-slot-recipe">
            <span className="meal-slot-recipe-name">{mealPlanEntryName(entry)}</span>
            {!entry.recipe && entry.text && entry.text !== entry.title ? <span className="meal-slot-note">{entry.text}</span> : null}
            <div className="meal-slot-recipe-actions">
              {entry.recipe?.slug ? <Link className="meal-slot-action-link" to={`/recipes/${entry.recipe.slug}`}>View</Link> : null}
              <button type="button" className="meal-slot-action-link" onClick={() => onReplace(entry)}>Replace</button>
              <button type="button" className="meal-slot-action-link" style={{color:'var(--danger)'}} onClick={() => onRemove(entry.id)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="btn-ghost btn-sm" onClick={onAdd}><Plus /> Add</button>
    </div>
  )
}

/** The meal slots for one day, plus a button for adding a side or snack. */
function MealPlanDaySlots({ dateKey, slotsFor, onAdd, onRemove }: {
  dateKey: string
  slotsFor: (dateKey: string, mealType: PlannableMealType) => MealieWeekPlan[]
  onAdd: (target: MealPlanTarget) => void
  onRemove: (entryId: string) => void
}) {
  const mealTypes = visibleMealTypes((mealType) => slotsFor(dateKey, mealType).length > 0)
  const missingExtra = EXTRA_MEAL_TYPES.find((mealType) => !mealTypes.includes(mealType))
  return (
    <>
      {mealTypes.map((mealType) => (
        <MealSlotCard
          key={mealType}
          mealType={mealType}
          entries={slotsFor(dateKey, mealType)}
          onAdd={() => onAdd({ date: dateKey, mealType })}
          onRemove={onRemove}
          onReplace={(entry) => onAdd({ date: dateKey, mealType, replaceEntryId: entry.id })}
        />
      ))}
      {missingExtra ? (
        <button type="button" className="meal-slot-add-extra" onClick={() => onAdd({ date: dateKey, mealType: missingExtra })}>
          <Plus /> Side or snack
        </button>
      ) : null}
    </>
  )
}

function MealPlanDayView({ date, slotsFor, onAdd, onRemove }: {
  date: Date
  slotsFor: (dateKey: string, mealType: PlannableMealType) => MealieWeekPlan[]
  onAdd: (target: MealPlanTarget) => void
  onRemove: (entryId: string) => void
}) {
  const dateKey = toDateKey(date)
  return (
    <section>
      <h2 className="meal-plan-day-heading">
        <span className="meal-plan-day-heading-name">{date.toLocaleDateString(undefined, { weekday: 'long' })}</span>
        <span className="meal-plan-day-heading-date">{date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
      </h2>
      <div className="meal-plan-day-slots">
        <MealPlanDaySlots dateKey={dateKey} slotsFor={slotsFor} onAdd={onAdd} onRemove={onRemove} />
      </div>
    </section>
  )
}

function MealPlanWeekView({ weekStart, slotsFor, onAdd, onRemove, onOpenDay }: {
  weekStart: Date
  slotsFor: (dateKey: string, mealType: PlannableMealType) => MealieWeekPlan[]
  onAdd: (target: MealPlanTarget) => void
  onRemove: (entryId: string) => void
  onOpenDay: (date: string) => void
}) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => new Date(weekStart.getTime() + index * DAY_MS)), [weekStart])
  return (
    <section className="meal-plan-week-view">
      {days.map((day) => {
        const dateKey = toDateKey(day)
        return (
          <div key={dateKey} className="meal-plan-week-day">
            <button type="button" className="meal-plan-week-day-heading" onClick={() => onOpenDay(dateKey)}>
              <span className="meal-plan-week-day-name">{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
              <span className="meal-plan-week-day-number">{day.getDate()}</span>
            </button>
            <div className="meal-plan-week-day-slots">
              <MealPlanDaySlots dateKey={dateKey} slotsFor={slotsFor} onAdd={onAdd} onRemove={onRemove} />
            </div>
          </div>
        )
      })}
    </section>
  )
}

const MONTH_SUMMARY_LABELS: Record<PlannableMealType, string> = {
  breakfast: 'B',
  lunch: 'L',
  dinner: 'D',
  side: 'Side',
  snack: 'Snack',
}

function MealPlanMonthView({ monthStart, slots, onOpenDay }: {
  monthStart: Date
  slots: MealPlanSlot[]
  onOpenDay: (date: string) => void
}) {
  const slotsByDate = useMemo(() => {
    const map = new Map<string, MealPlanSlot[]>()
    for (const slot of slots) {
      const existing = map.get(slot.date) ?? []
      existing.push(slot)
      map.set(slot.date, existing)
    }
    return map
  }, [slots])

  const firstDayOffset = startOfWeek(monthStart).getDate() === monthStart.getDate() ? 0 : monthStart.getDay()
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate()
  const cells = useMemo(() => {
    const result: (Date | null)[] = []
    for (let index = 0; index < firstDayOffset; index += 1) result.push(null)
    for (let day = 1; day <= daysInMonth; day += 1) result.push(new Date(monthStart.getFullYear(), monthStart.getMonth(), day))
    return result
  }, [firstDayOffset, daysInMonth, monthStart])

  const mealSummary = (mealType: PlannableMealType, daySlots: MealPlanSlot[]) => {
    const slot = daySlots.find((candidate) => candidate.entryType === mealType)
    if (!slot || slot.entries.length === 0) return null
    return `${MONTH_SUMMARY_LABELS[mealType]}: ${slot.entries.map(mealPlanEntryName).join(', ')}`
  }

  return (
    <section>
      <h2 className="meal-plan-month-heading">{monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      <div className="meal-plan-month-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => (
          <div key={label} className="meal-plan-month-weekday">{label}</div>
        ))}
        {cells.map((day, index) => {
          if (!day) return <div key={`empty-${index}`} className="meal-plan-month-cell empty" />
          const dateKey = toDateKey(day)
          const daySlots = slotsByDate.get(dateKey) ?? []
          const summaries = PLANNABLE_MEAL_TYPES.map((mealType) => mealSummary(mealType, daySlots)).filter(Boolean)
          return (
            <button key={dateKey} type="button" className="meal-plan-month-cell" onClick={() => onOpenDay(dateKey)}>
              <span className="meal-plan-month-day-number">{day.getDate()}</span>
              {summaries.map((summary) => (<span key={summary} className="meal-plan-month-summary">{summary}</span>))}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function MealTypeSelect({ id, value, onChange }: { id: string; value: PlannableMealType; onChange: (value: PlannableMealType) => void }) {
  return (
    <select id={id} className="form-select" value={value} onChange={(event) => onChange(event.target.value as PlannableMealType)}>
      {PLANNABLE_MEAL_TYPES.map((type) => (<option key={type} value={type}>{MEAL_TYPE_LABELS[type]}</option>))}
    </select>
  )
}

/** Picks what goes in a meal-plan slot: search for a recipe, or type a title. */
function MealPlanEntryModal({ activeProfile, target, onSelect, onClose }: {
  activeProfile: MealieProfile
  target: MealPlanTarget
  onSelect: (choice: MealPlanEntryChoice) => void
  onClose: () => void
}) {
  useModalEscapeToClose(onClose)
  const [mode, setMode] = useState<'recipe' | 'title'>('recipe')
  const [mealType, setMealType] = useState<PlannableMealType>(target.mealType)
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState<MealieCategory[]>([])
  const [tags, setTags] = useState<MealieTag[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [tagId, setTagId] = useState('')
  const [recipes, setRecipes] = useState<MealieRecipeSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    client.getCategories().then(setCategories).catch(() => undefined)
    client.getTags().then(setTags).catch(() => undefined)
  }, [activeProfile])

  useEffect(() => {
    if (mode !== 'recipe') return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')
    const timeout = window.setTimeout(() => {
      client.getRecipes({ search: search.trim() || undefined, categories: categoryId ? [categoryId] : undefined, tags: tagId ? [tagId] : undefined })
        .then((result) => setRecipes(result))
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false))
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [activeProfile, mode, search, categoryId, tagId])

  const submitTitle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) return
    onSelect({ mealType, title: title.trim(), text: note.trim() })
  }

  const mealLabel = MEAL_TYPE_LABELS[mealType] ?? mealType
  const heading = target.replaceEntryId
    ? 'Replace meal'
    : (EXTRA_MEAL_TYPES as readonly string[]).includes(mealType) ? `Add a ${mealLabel.toLowerCase()}` : `Add to ${mealLabel}`

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={heading}>
      <div className="modal-panel recipe-picker-panel">
        <h3>{heading}</h3>
        <div className="meal-entry-modal-controls">
          <div className="segmented" role="tablist" aria-label="What to add">
            <button type="button" role="tab" aria-selected={mode === 'recipe'} className={mode === 'recipe' ? 'segmented-btn active' : 'segmented-btn'} onClick={() => setMode('recipe')}>Recipe</button>
            <button type="button" role="tab" aria-selected={mode === 'title'} className={mode === 'title' ? 'segmented-btn active' : 'segmented-btn'} onClick={() => setMode('title')}>Type a title</button>
          </div>
          <label className="sr-only" htmlFor="meal-entry-type">Meal</label>
          <MealTypeSelect id="meal-entry-type" value={mealType} onChange={setMealType} />
        </div>

        {mode === 'recipe' ? (
          <>
            <div className="recipe-picker-filters">
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search recipes..." aria-label="Search recipes" />
              <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="Filter by category">
                <option value="">All categories</option>
                {categories.map((category) => (<option key={category.id} value={category.id}>{category.name}</option>))}
              </select>
              <select value={tagId} onChange={(event) => setTagId(event.target.value)} aria-label="Filter by tag">
                <option value="">All tags</option>
                {tags.map((tag) => (<option key={tag.id} value={tag.id}>{tag.name}</option>))}
              </select>
            </div>
            {error ? <p className="error-message">{error}</p> : null}
            {loading ? <p style={{color:'var(--text-muted)', padding:'var(--sp-2)'}}>Searching...</p> : null}
            <ul className="recipe-picker-results">
              {!loading && recipes.length === 0 ? <li className="meal-slot-empty">No recipes match. You can also type a title instead.</li> : null}
              {recipes.map((recipe) => (
                <li key={recipe.id}>
                  <button type="button" className="recipe-picker-result" onClick={() => onSelect({ mealType, recipe })}>{recipe.name}</button>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <form className="form-stack meal-entry-title-form" onSubmit={submitTitle}>
            <div className="form-field">
              <label className="form-label" htmlFor="meal-entry-title">Title</label>
              <input id="meal-entry-title" className="form-input" type="text" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Leftovers, Pizza night, Side salad..." autoFocus />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="meal-entry-note">Note (optional)</label>
              <input id="meal-entry-note" className="form-input" type="text" value={note} onChange={(event) => setNote(event.target.value)} placeholder="From Tuesday's roast" />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={!title.trim()}>{target.replaceEntryId ? 'Replace' : 'Add to Meal Plan'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function RouletteRedirect() {
  const navigate = useNavigate()
  useEffect(() => { navigate('/roulette', { replace: true }) }, [navigate])
  return null
}

interface RouletteResultRecipe extends MealieRecipeSummary {
  __detail?: MealieRecipeDetail
}

function DinnerRoulettePage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [categories, setCategories] = useState<MealieCategory[]>([])
  const [tags, setTags] = useState<MealieTag[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [maxPrepTime, setMaxPrepTime] = useState<number | undefined>(undefined)
  const [maxCookTime, setMaxCookTime] = useState<number | undefined>(undefined)
  const [customPrep, setCustomPrep] = useState('')
  const [customCook, setCustomCook] = useState('')
  const [ingredients, setIngredients] = useState<string[]>([])
  const [ingredientMode, setIngredientMode] = useState<'any' | 'all'>('any')
  const [rolling, setRolling] = useState(false)
  const [error, setError] = useState('')
  const [searchedNoResults, setSearchedNoResults] = useState(false)
  const [result, setResult] = useState<RouletteResultRecipe | null>(null)
  const [showMealPlanModal, setShowMealPlanModal] = useState(false)
  const [showShoppingModal, setShowShoppingModal] = useState(false)
  const recentResultIds = useRef<string[]>([])

  useEffect(() => {
    if (!activeProfile) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    Promise.allSettled([client.getCategories(), client.getTags()]).then(([categoryResult, tagResult]) => {
      if (categoryResult.status === 'fulfilled') setCategories(categoryResult.value)
      if (tagResult.status === 'fulfilled') setTags(tagResult.value)
    })
  }, [activeProfile])

  const toggleTag = (id: string) => { setTagIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id])) }
  const clearCategory = () => setCategoryId('')
  const clearTags = () => setTagIds([])
  const clearTimeFilters = () => { setMaxPrepTime(undefined); setMaxCookTime(undefined); setCustomPrep(''); setCustomCook('') }
  const clearIngredients = () => setIngredients([])
  const clearAllFilters = () => { clearCategory(); clearTags(); clearTimeFilters(); clearIngredients() }
  const hasAnyFilter = Boolean(categoryId) || tagIds.length > 0 || maxPrepTime !== undefined || maxCookTime !== undefined || ingredients.length > 0
  const timePresets = [10, 20, 30, 45, 60]

  const roll = useCallback(async () => {
    if (!activeProfile) return
    setRolling(true)
    setError('')
    setSearchedNoResults(false)
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      const filters = { categories: categoryId ? [categoryId] : undefined, tags: tagIds.length > 0 ? tagIds : undefined, maxPrepTime, maxCookTime }
      const pool: RouletteResultRecipe[] = ingredients.length > 0
        ? (await findRecipesByIngredients(client, ingredients, { mode: ingredientMode, filters })).map((match) => match.recipe)
        : await client.getAllRecipes(filters)
      if (pool.length === 0) { setResult(null); setSearchedNoResults(true); return }
      const notRecentlyShown = pool.filter((recipe) => !recentResultIds.current.includes(recipe.id))
      const choicePool = notRecentlyShown.length > 0 ? notRecentlyShown : pool
      const chosen = choicePool[Math.floor(Math.random() * choicePool.length)]
      recentResultIds.current = [chosen.id, ...recentResultIds.current].slice(0, 5)
      setResult(chosen as RouletteResultRecipe)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to roll for a recipe.')
    } finally {
      setRolling(false)
    }
  }, [activeProfile, categoryId, tagIds, maxPrepTime, maxCookTime, ingredients, ingredientMode])

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content">
        <div className="sticky-back-bar">
          <Link className="btn-ghost btn-sm" to="/"><ChevronLeft /> Home</Link>
        </div>

        {!activeProfile ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Dice5 /></div>
            <p className="empty-state-title">Dinner Roulette</p>
            <p className="empty-state-text">No active Mealie account is connected.</p>
            <Link className="btn-primary" to="/setup">Connect to Mealie</Link>
          </div>
        ) : (
          <>
            <div className="page-intro">
              <p className="eyebrow">A Mealie Connect original</p>
              <h1 className="page-intro-title">Dinner Roulette</h1>
              <p className="page-intro-text">Don't know what to cook? Roll completely at random, or narrow it down below.</p>
            </div>

            <section className="roulette-filters">
              <div className="roulette-filter-group">
                <h4>Category</h4>
                <select className="form-select" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  <option value="">All categories</option>
                  {categories.map((category) => (<option key={category.id} value={category.id}>{category.name}</option>))}
                </select>
              </div>

              <div className="roulette-filter-group">
                <h4>Prep time</h4>
                <div className="chip-list">
                  <button type="button" className={maxPrepTime === undefined ? 'chip active' : 'chip'} onClick={() => { setMaxPrepTime(undefined); setCustomPrep('') }}>Any</button>
                  {timePresets.map((minutes) => (
                    <button key={minutes} type="button" className={maxPrepTime === minutes ? 'chip active' : 'chip'} onClick={() => { setMaxPrepTime(minutes); setCustomPrep('') }}>{minutes} min</button>
                  ))}
                  <input type="number" min={1} className="roulette-custom-time" placeholder="Custom" value={customPrep} onChange={(event) => { setCustomPrep(event.target.value); const parsed = Number.parseInt(event.target.value, 10); setMaxPrepTime(Number.isNaN(parsed) ? undefined : parsed) }} aria-label="Custom maximum prep time in minutes" />
                </div>
              </div>

              <div className="roulette-filter-group">
                <h4>Cook time</h4>
                <div className="chip-list">
                  <button type="button" className={maxCookTime === undefined ? 'chip active' : 'chip'} onClick={() => { setMaxCookTime(undefined); setCustomCook('') }}>Any</button>
                  {timePresets.map((minutes) => (
                    <button key={minutes} type="button" className={maxCookTime === minutes ? 'chip active' : 'chip'} onClick={() => { setMaxCookTime(minutes); setCustomCook('') }}>{minutes} min</button>
                  ))}
                  <input type="number" min={1} className="roulette-custom-time" placeholder="Custom" value={customCook} onChange={(event) => { setCustomCook(event.target.value); const parsed = Number.parseInt(event.target.value, 10); setMaxCookTime(Number.isNaN(parsed) ? undefined : parsed) }} aria-label="Custom maximum cook time in minutes" />
                </div>
              </div>

              <div className="roulette-filter-group">
                <h4>Tags</h4>
                <div className="chip-list">
                  {tags.length === 0 ? <p style={{color:'var(--text-muted)', fontSize:'0.85rem'}}>No tags found on your Mealie server.</p> : null}
                  {tags.map((tag) => (
                    <button key={tag.id} type="button" className={tagIds.includes(tag.id) ? 'chip active' : 'chip'} onClick={() => toggleTag(tag.id)}>{tag.name}</button>
                  ))}
                </div>
              </div>

              <div className="roulette-filter-group">
                <h4>Ingredients on hand</h4>
                <IngredientChipsInput id="roulette-ingredient" label="Add an ingredient you have on hand" values={ingredients} onChange={setIngredients} />
                {ingredients.length > 1 ? <div className="roulette-ingredient-mode"><MatchModeToggle mode={ingredientMode} onChange={setIngredientMode} /></div> : null}
              </div>

              {hasAnyFilter ? <button type="button" className="btn-ghost btn-sm" onClick={clearAllFilters}>Clear all filters</button> : null}
            </section>

            {error ? <p className="error-message">{error}</p> : null}

            <div className="roulette-roll-section">
              <button type="button" className="roulette-roll-btn" onClick={() => void roll()} disabled={rolling}>
                <span className={rolling ? 'roulette-dice rolling' : 'roulette-dice'}><Dice5 size={24} /></span>
                {rolling ? 'Rolling...' : 'Roll'}
              </button>
            </div>

            {searchedNoResults ? (
              <div className="roulette-no-results">
                <p><strong>No recipes match those filters.</strong></p>
                <div className="roulette-current-filters">
                  {categoryId ? <span className="chip active">{categories.find((category) => category.id === categoryId)?.name ?? 'Category'}</span> : null}
                  {tagIds.map((id) => <span key={id} className="chip active">{tags.find((tag) => tag.id === id)?.name ?? 'Tag'}</span>)}
                  {maxPrepTime !== undefined ? <span className="chip active">Prep max {maxPrepTime} min</span> : null}
                  {maxCookTime !== undefined ? <span className="chip active">Cook max {maxCookTime} min</span> : null}
                  {ingredients.map((ingredient) => <span key={ingredient} className="chip active">{ingredient}</span>)}
                </div>
                <div className="roulette-clear-buttons">
                  {ingredients.length > 0 ? <button type="button" className="btn-secondary btn-sm" onClick={clearIngredients}>Clear ingredients</button> : null}
                  {(maxPrepTime !== undefined || maxCookTime !== undefined) ? <button type="button" className="btn-secondary btn-sm" onClick={clearTimeFilters}>Clear time filters</button> : null}
                  {tagIds.length > 0 ? <button type="button" className="btn-secondary btn-sm" onClick={clearTags}>Clear tags</button> : null}
                  {categoryId ? <button type="button" className="btn-secondary btn-sm" onClick={clearCategory}>Clear category</button> : null}
                  <button type="button" className="btn-secondary btn-sm" onClick={clearAllFilters}>Clear all</button>
                </div>
              </div>
            ) : null}

            {result ? (
              <div className="roulette-result">
                {activeProfile ? <RecipeThumbnail activeProfile={activeProfile} recipe={result} className="roulette-result-image" size="original" /> : null}
                <div className="roulette-result-body">
                  <p className="eyebrow">Tonight's recipe</p>
                  <h2>{result.name}</h2>
                  {result.description ? <p>{result.description}</p> : null}
                  <div className="chip-list" style={{marginTop:'var(--sp-3)'}}>
                    {(result.categories ?? []).map((category) => <span key={category.id} className="chip">{category.name}</span>)}
                    {(result.tags ?? []).map((tag) => <span key={tag.id} className="chip">{tag.name}</span>)}
                    {result.prepTime ? <span className="chip">Prep: {formatMealieTime(result.prepTime)}</span> : null}
                    {result.cookTime ? <span className="chip">Cook: {formatMealieTime(result.cookTime)}</span> : null}
                  </div>
                  <div className="roulette-result-actions">
              <Link className="btn-primary" to={`/cook/${result.slug || result.id}`}>Cook Now</Link>
                    <button type="button" className="btn-secondary" onClick={() => setShowMealPlanModal(true)}>Add to Meal Plan</button>
                    <button type="button" className="btn-secondary" onClick={() => setShowShoppingModal(true)}>Add to Shopping</button>
              <Link className="btn-ghost" to={`/recipes/${result.slug || result.id}`}>View Recipe</Link>
                    <button type="button" className="btn-ghost" onClick={() => void roll()} disabled={rolling}>Roll Again</button>
                  </div>
                </div>
              </div>
            ) : null}

            {showMealPlanModal && result ? (
              <AddToMealPlanModal activeProfile={activeProfile} recipe={result} onClose={() => setShowMealPlanModal(false)} />
            ) : null}
            {showShoppingModal && result ? (
              <AddIngredientsToShoppingListModal activeProfile={activeProfile} recipeId={result.id} recipeName={result.name} onClose={() => setShowShoppingModal(false)} />
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}

function AddToMealPlanModal({ activeProfile, recipe, onClose }: {
  activeProfile: MealieProfile
  recipe: MealieRecipeSummary
  onClose: () => void
}) {
  useModalEscapeToClose(onClose)
  const [date, setDate] = useState(() => toDateKey(new Date()))
  const [mealType, setMealType] = useState<PlannableMealType>('dinner')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      await client.createMealPlanEntry({ date, entryType: mealType, title: recipe.name, recipeId: recipe.id })
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add to your meal plan.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add to meal plan">
      <div className="modal-panel">
        {success ? (
          <>
            <p className="success-message">Added {recipe.name} to {MEAL_TYPE_LABELS[mealType]} on {date}</p>
            <div className="modal-actions">
              <Link className="btn-secondary" to="/meal-plan">View Meal Plan</Link>
              <button type="button" className="btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h3>Add to meal plan</h3>
            <p style={{color:'var(--text-secondary)', fontSize:'0.9rem', marginBottom:'var(--sp-4)'}}>{recipe.name}</p>
            <div className="form-field">
              <label className="form-label" htmlFor="modal-date">Date</label>
              <input id="modal-date" className="form-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="modal-meal">Meal</label>
              <select id="modal-meal" className="form-select" value={mealType} onChange={(event) => setMealType(event.target.value as PlannableMealType)}>
                {PLANNABLE_MEAL_TYPES.map((type) => (<option key={type} value={type}>{MEAL_TYPE_LABELS[type]}</option>))}
              </select>
            </div>
            {error ? <p className="error-message">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => void submit()} disabled={submitting}>{submitting ? 'Adding...' : 'Add to Meal Plan'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function AddIngredientsToShoppingListModal({ activeProfile, recipeId, recipeName, scale = 1, onClose }: {
  activeProfile: MealieProfile
  recipeId: string
  recipeName: string
  /** Multiplier for ingredient quantities, from the servings scaler. */
  scale?: number
  onClose: () => void
}) {
  useModalEscapeToClose(onClose)
  const [lists, setLists] = useState<MealieShoppingList[]>([])
  const [loadingLists, setLoadingLists] = useState(true)
  const [listError, setListError] = useState('')
  const [mode, setMode] = useState<'select' | 'create'>('select')
  const [selectedListId, setSelectedListId] = useState('')
  const [newListName, setNewListName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ listId: string; listName: string; added: number } | null>(null)

  useEffect(() => {
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    client.getShoppingLists().then((nextLists) => {
      setLists(nextLists)
      setSelectedListId(nextLists[0]?.id ?? '')
      if (nextLists.length === 0) setMode('create')
    }).catch((err: Error) => setListError(err.message)).finally(() => setLoadingLists(false))
  }, [activeProfile])

  const submit = async () => {
    setError('')
    setSubmitting(true)
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      let targetListId = selectedListId
      let targetListName = lists.find((list) => list.id === selectedListId)?.name ?? ''
      const initialItemCount = mode === 'create' ? 0 : lists.find((list) => list.id === selectedListId)?.items?.length ?? 0
      if (mode === 'create') {
        if (!newListName.trim()) throw new Error('Enter a name for the new shopping list.')
        const created = await client.createShoppingList(newListName.trim())
        targetListId = created.id
        targetListName = created.name
      } else if (!targetListId) {
        throw new Error('Choose a shopping list.')
      }
      const updated = await client.addRecipeIngredientsToShoppingList(targetListId, recipeId, scale)
      setResult({ listId: targetListId, listName: targetListName, added: Math.max(0, (updated.items?.length ?? 0) - initialItemCount) })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add ingredients.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add ingredients to shopping list">
      <div className="modal-panel">
        {result ? (
          <>
            <p className="success-message">Added {result.added} ingredient{result.added === 1 ? '' : 's'} to {result.listName}</p>
            <div className="modal-actions">
              <Link className="btn-secondary" to={`/shopping/${result.listId}`}>View Shopping List</Link>
              <button type="button" className="btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h3>Add ingredients</h3>
            <p style={{color:'var(--text-secondary)', fontSize:'0.9rem', marginBottom:'var(--sp-4)'}}>{recipeName}{scale !== 1 ? ` (quantities ×${formatQuantity(scale)})` : ''}</p>
            {loadingLists ? <p style={{color:'var(--text-muted)'}}>Loading your shopping lists...</p> : null}
            {listError ? <p className="error-message">{listError}</p> : null}
            {!loadingLists ? (
              <div className="shopping-target-picker">
                {lists.length > 0 ? (
                  <label>
                    <input type="radio" name="shopping-target-mode" checked={mode === 'select'} onChange={() => setMode('select')} />
                    Existing shopping list
                  </label>
                ) : null}
                {mode === 'select' && lists.length > 0 ? (
                  <select className="form-select" value={selectedListId} onChange={(event) => setSelectedListId(event.target.value)}>
                    {lists.map((list) => (<option key={list.id} value={list.id}>{list.name}</option>))}
                  </select>
                ) : null}
                <label>
                  <input type="radio" name="shopping-target-mode" checked={mode === 'create'} onChange={() => setMode('create')} />
                  Create new shopping list
                </label>
                {mode === 'create' ? (
                  <input className="form-input" type="text" value={newListName} onChange={(event) => setNewListName(event.target.value)} placeholder="Shopping list name" aria-label="New shopping list name" />
                ) : null}
              </div>
            ) : null}
            {error ? <p className="error-message">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="button" className="btn-primary" onClick={() => void submit()} disabled={submitting || loadingLists}>{submitting ? 'Adding...' : mode === 'create' ? 'Create and Add Ingredients' : 'Add Ingredients'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default App




