import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { KeepAwake } from '@capacitor-community/keep-awake'
import type { PluginListenerHandle } from '@capacitor/core'
import { Network } from '@capacitor/network'
import {
  BookOpen,
  Calendar,
  ChevronLeft,
  Dice5,
  Download,
  Home,
  Plus,
  Search,
  Settings,
  ShoppingCart,
  Utensils,
  X,
} from 'lucide-react'
import { authService } from './services/auth/auth-service'
import { MealieClient, groupMealPlanEntriesIntoSlots, type MealPlanSlot } from './services/mealie/mealie-client'
import { THEMES, getStoredTheme, setTheme as persistTheme } from './lib/theme'
import { isAndroidPlatform, isExternalHttpUrl, isNativePlatform, openExternalUrl, removeNativeListener } from './lib/native'
import defaultRecipeImage from './assets/default-image.jpg'
import type {
  AuthMethod,
  MealieCategory,
  MealieInstructionStep,
  MealieProfile,
  MealieRecipeDetail,
  MealieRecipeSummary,
  MealieShoppingList,
  MealieTag,
  MealieWeekPlan,
  PlannableMealType,
  ThemeName,
} from './types/mealie'
import { PLANNABLE_MEAL_TYPES } from './types/mealie'
import './App.css'

const APP_VERSION = '0.7.5'
const RECIPES_PAGE_SIZE = 50
const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
}

type ConnectivityState = 'online' | 'offline' | 'server-unreachable' | 'auth-failed'

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
  const [current, setCurrent] = useState<ThemeName>(() => getStoredTheme())
  const choose = (theme: ThemeName) => {
    persistTheme(theme)
    setCurrent(theme)
  }
  return (
    <div className="theme-menu" role="group" aria-label="Choose a color theme">
      {THEMES.map((theme) => (
        <button
          key={theme.id}
          type="button"
          className={current === theme.id ? 'theme-swatch-btn active' : 'theme-swatch-btn'}
          onClick={() => choose(theme.id)}
          aria-pressed={current === theme.id}
          title={theme.label}
        >
          <span className="theme-swatch-dot" style={{ backgroundColor: theme.swatch }} aria-hidden="true" />
          <span>{theme.label}</span>
        </button>
      ))}
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
  const [loading, setLoading] = useState(false)
  const [loadingMoreRecipes, setLoadingMoreRecipes] = useState(false)
  const [hasMoreRecipes, setHasMoreRecipes] = useState(false)
  const [error, setError] = useState('')
  const [networkConnected, setNetworkConnected] = useState(true)
  const [connectivityState, setConnectivityState] = useState<ConnectivityState | null>(null)

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
      return
    }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    const timeout = window.setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const results = await Promise.allSettled([
          client.getRecipes({ search: searchTerm, categories: selectedCategories, tags: selectedTags, page: 1, perPage: RECIPES_PAGE_SIZE }),
          client.getCategories(),
          client.getTags(),
        ])
        const nextRecipes = results[0]?.status === 'fulfilled' ? results[0].value : []
        const nextCategories = results[1]?.status === 'fulfilled' ? results[1].value : []
        const nextTags = results[2]?.status === 'fulfilled' ? results[2].value : []
        setRecipes(nextRecipes)
        setHasMoreRecipes(nextRecipes.length === RECIPES_PAGE_SIZE)
        setCategories(nextCategories)
        setTags(nextTags)
        if (results[0]?.status === 'rejected') {
          const message = results[0].reason instanceof Error ? results[0].reason.message : 'Unable to load recipes.'
          setError(message)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to load Mealie data.'
        setError(message)
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [activeProfile, searchTerm, selectedCategories, selectedTags])

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

  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<HomePage activeProfile={activeProfile} recipes={recipes} loading={loading} error={error} />} />
        <Route path="/settings" element={<SettingsPage activeProfile={activeProfile} profiles={profiles} onSelectProfile={selectProfile} onSignOut={signOut} />} />
        <Route path="/setup" element={<SetupPage onSignIn={signIn} profiles={profiles} onBack={() => window.history.back()} onSelectProfile={selectProfile} />} />
        <Route path="/import" element={<ImportRecipePage activeProfile={activeProfile} />} />
        <Route path="/recipes" element={
          <RecipesPage
            activeProfile={activeProfile} recipes={recipes} categories={categories} tags={tags}
            searchTerm={searchTerm} setSearchTerm={setSearchTerm}
            selectedCategories={selectedCategories} setSelectedCategories={setSelectedCategories}
            selectedTags={selectedTags} setSelectedTags={setSelectedTags}
            loading={loading} loadingMore={loadingMoreRecipes} hasMore={hasMoreRecipes}
            onLoadMore={loadMoreRecipes} error={error}
          />
        } />
        <Route path="/recipes/:slug" element={<RecipeDetailPage activeProfile={activeProfile} />} />
        <Route path="/cook/:slug" element={<CookModePage activeProfile={activeProfile} />} />
        <Route path="/shopping" element={<ShoppingListsPage activeProfile={activeProfile} />} />
        <Route path="/shopping/:id" element={<ShoppingListDetailPage activeProfile={activeProfile} />} />
        <Route path="/meal-plan" element={<MealPlanPage activeProfile={activeProfile} />} />
        <Route path="/random-recipe" element={<RouletteRedirect />} />
        <Route path="/roulette" element={<DinnerRoulettePage activeProfile={activeProfile} />} />
      </Routes>
      <MobileNav activeProfile={activeProfile} />
      <NativeConnectionStatus state={connectivityState} />
    </BrowserRouter>
  )
}

function HomePage({ activeProfile, recipes, loading, error }: {
  activeProfile: MealieProfile | null
  recipes: MealieRecipeSummary[]
  loading: boolean
  error: string
}) {
  const featured = recipes[0] ?? null
  const recent = useMemo(() => recipes.slice(1, 7), [recipes])

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
                <RecipeThumbnail activeProfile={activeProfile} recipe={featured} className="hero-image" />
                <div className="hero-gradient" aria-hidden="true" />
                <div className="hero-content">
                  <p className="eyebrow hero-eyebrow">{featured.categories?.[0]?.name ?? 'Featured recipe'}</p>
                  <h1 className="hero-title">{featured.name}</h1>
                  {featured.description ? <p className="hero-description">{featured.description}</p> : null}
                  <div className="hero-meta">
                    {featured.totalTime ? <span className="hero-meta-item">{featured.totalTime} min</span> : null}
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

            {error ? <p className="error-message" style={{marginTop: 'var(--sp-4)'}}>{error}</p> : null}

            {recent.length > 0 ? (
              <section className="home-section">
                <div className="section-header">
                  <div>
                    <p className="eyebrow">From your library</p>
                    <h2 className="section-title">Recent recipes</h2>
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
                        {recipe.totalTime ? <p className="recipe-card-meta">{recipe.totalTime} min</p> : null}
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
                  <div className="home-tool-card-desc">Let chance pick tonight recipe.</div>
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

function SettingsPage({ activeProfile, profiles, onSelectProfile, onSignOut }: {
  activeProfile: MealieProfile | null
  profiles: MealieProfile[]
  onSelectProfile: (profile: MealieProfile) => void
  onSignOut: () => void
}) {
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
              {profiles.length > 1 ? (
                <div className="profile-list">
                  {profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className={activeProfile.id === profile.id ? 'profile-list-item active' : 'profile-list-item'}
                      onClick={() => onSelectProfile(profile)}
                    >
                      {profile.displayName ?? profile.username ?? profile.name}
                    </button>
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
              <button type="button" className="btn-danger" onClick={onSignOut}>Sign out</button>
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
  const [server, setServer] = useState('https://mealie.example.com')
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
              <input id="setup-server" className="form-input" type="url" value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://mealie.example.com" />
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
                  <input id="setup-username" className="form-input" value={username} onChange={(event) => setUsername(event.target.value)} />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="setup-password">Password</label>
                  <input id="setup-password" className="form-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
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
                <h3>CORS error: use the local proxy</h3>
                <div className="help-text">
                  <p><strong>What is happening?</strong> Your browser is blocking the connection because your Mealie server does not have CORS enabled.</p>
                  <p><strong>Quick Fix:</strong> Use the included CORS proxy</p>
                  <ol className="proxy-steps">
                    <li>Open a terminal in the Mealie Connect folder and run: <code>node cors-proxy.js</code></li>
                    <li>You should see Proxy is listening on http://localhost:3001</li>
                    <li>In the URL field above, enter: <code>http://localhost:3001</code></li>
                    <li>Click Continue</li>
                  </ol>
                  <p className="small-text">The proxy runs locally on your computer and forwards requests to your actual Mealie server while adding the necessary CORS headers.</p>
                  <p className="small-text">In the Android app, Mealie requests use Capacitor native HTTP bridge, so browser CORS rules do not apply there. This proxy is only for the web app running in a browser.</p>
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

function RecipeThumbnail({ activeProfile, recipe, className = 'recipe-thumbnail' }: {
  activeProfile: MealieProfile
  recipe: MealieRecipeSummary
  className?: string
}) {
  const [imageUrl, setImageUrl] = useState('')
  useEffect(() => {
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    const sourceUrl = client.resolveRecipeImage(recipe)
    if (!sourceUrl) return
    let disposed = false
    client.loadRecipeImage(sourceUrl).then((nextImageUrl) => {
      if (disposed) { URL.revokeObjectURL(nextImageUrl); return }
      setImageUrl(nextImageUrl)
    }).catch(() => setImageUrl(''))
    return () => {
      disposed = true
      setImageUrl((currentImageUrl) => {
        if (currentImageUrl) URL.revokeObjectURL(currentImageUrl)
        return ''
      })
    }
  }, [activeProfile, recipe])
  return <img className={className} src={imageUrl || defaultRecipeImage} alt="" />
}

function RecipesPage({ activeProfile, recipes, categories, tags, searchTerm, setSearchTerm, selectedCategories, setSelectedCategories, selectedTags, setSelectedTags, loading, loadingMore, hasMore, onLoadMore, error }: {
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
  const clearFilters = () => { setSelectedCategories([]); setSelectedTags([]) }

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
            </div>

            {loading ? <p style={{padding: 'var(--sp-4) 0', color: 'var(--text-muted)'}}>Loading recipes...</p> : null}
            {error ? <p className="error-message">{error}</p> : null}

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
                      {recipe.description ? <p className="recipe-card-meta">{recipe.description}</p> : null}
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

function RecipeDetailPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { slug } = useParams()
  const [recipe, setRecipe] = useState<MealieRecipeDetail | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showShoppingModal, setShowShoppingModal] = useState(false)
  const [showMealPlanModal, setShowMealPlanModal] = useState(false)

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

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content">
        <div className="sticky-back-bar">
          <Link className="btn-ghost btn-sm" to="/recipes"><ChevronLeft /> Recipes</Link>
        {recipe ? <Link className="btn-primary btn-sm" to={`/cook/${recipe.slug || recipe.id}`}><Utensils /> Cook this</Link> : null}
        </div>

        {loading ? <p style={{color:'var(--text-muted)', padding:'var(--sp-8) 0'}}>Loading recipe...</p> : null}
        {error ? <p className="error-message">{error}</p> : null}
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
                  {recipe.totalTime ? <span className="detail-meta-item">{recipe.totalTime} min total</span> : null}
                  {recipe.prepTime ? <span className="detail-meta-item">{recipe.prepTime} prep</span> : null}
                  {recipe.cookTime ? <span className="detail-meta-item">{recipe.cookTime} cook</span> : null}
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
                <ul className="ingredient-list">
                  {ingredients.length > 0 ? ingredients.map((ingredient, index) => {
                    const ingredientText = ingredient.display ?? ingredient.note ?? `${ingredient.quantity ?? ""} ${ingredient.unit ?? ""} ${ingredient.food ?? ""}`.trim()
                    return (
                      <li key={`${ingredient.id ?? "ingredient"}-${index}`} className="ingredient-item">
                        <span className="ingredient-bullet" aria-hidden="true" />
                        {ingredientText}
                      </li>
                    )
                  }) : <li className="ingredient-item">No ingredients listed.</li>}
                </ul>
              </aside>

              <section className="detail-content">
                <h2 className="instructions-heading">Instructions</h2>
                <ol className="instructions-list">
                  {steps.length > 0 ? steps.map((step, index) => (
                    <li key={`${step.id ?? "step"}-${index}`} className="instruction-step">
                      <span className="step-number">{index + 1}</span>
                      <p className="step-text">{step.text ?? step.instruction ?? `Step ${index + 1}`}</p>
                    </li>
                  )) : <li className="instruction-step"><p className="step-text">No instructions available.</p></li>}
                </ol>
              </section>
            </div>
          </>
        ) : null}

        {recipe && showShoppingModal && activeProfile ? (
          <AddIngredientsToShoppingListModal activeProfile={activeProfile} recipeId={recipe.id} recipeName={recipe.name} onClose={() => setShowShoppingModal(false)} />
        ) : null}
        {recipe && showMealPlanModal && activeProfile ? (
          <AddToMealPlanModal activeProfile={activeProfile} recipe={recipe} onClose={() => setShowMealPlanModal(false)} />
        ) : null}
      </main>
    </div>
  )
}

function CookModePage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { slug } = useParams()
  const [recipe, setRecipe] = useState<MealieRecipeDetail | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!activeProfile || !slug) { setRecipe(null); return }
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')
    client.getRecipe(slug).then((nextRecipe) => { setRecipe(nextRecipe); setCurrentStep(0) }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false))
  }, [activeProfile, slug])

  useEffect(() => {
    if (!isNativePlatform()) return
    let released = false
    void KeepAwake.keepAwake()
    return () => {
      if (released) return
      released = true
      void KeepAwake.allowSleep()
    }
  }, [])

  const steps = recipe ? normalizeInstructionSteps(recipe) : []
  const current = steps[currentStep]

  return (
    <div className="app-page">
      <AppHeader activeProfile={activeProfile} />
      <main className="page-content narrow">
        <div className="sticky-back-bar">
          <Link className="btn-ghost btn-sm" to={recipe ? `/recipes/${recipe.slug || recipe.id}` : "/recipes"}>
            <ChevronLeft /> Return to recipe
          </Link>
        </div>

        {loading ? <p style={{color:'var(--text-muted)', padding:'var(--sp-8) 0'}}>Loading cook mode...</p> : null}
        {error ? <p className="error-message">{error}</p> : null}

        {recipe && current ? (
          <div className="cook-content">
            <p className="eyebrow cook-recipe-name">{recipe.name}</p>
            <p className="cook-step-label">Step {currentStep + 1} of {steps.length}</p>
            <div className="cook-progress">
              <div className="cook-progress-fill" style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }} />
            </div>
            <div className="cook-step-card">
              <span className="step-number">{currentStep + 1}</span>
              <p className="step-text">{current.text ?? current.instruction ?? `Step ${currentStep + 1}`}</p>
            </div>
            <div className="cook-actions">
              <button type="button" className="btn-secondary" onClick={() => setCurrentStep((value) => Math.max(0, value - 1))} disabled={currentStep === 0}>
                <ChevronLeft /> Previous
              </button>
              <button type="button" className="btn-primary" onClick={() => setCurrentStep((value) => Math.min(steps.length - 1, value + 1))} disabled={currentStep >= steps.length - 1}>
                Next
              </button>
            </div>
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

  const toggleItem = async (itemId: string | undefined, checked: boolean) => {
    if (!activeProfile || !list || !itemId) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    try {
      const updated = await client.updateShoppingListItem(list.id, itemId, { checked: !checked })
      setList(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update item.')
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
                  <li key={`${item.id ?? "item"}-${index}`} className={item.checked ? "shopping-item checked" : "shopping-item"}>
                    <input className="shopping-item-checkbox" type="checkbox" checked={item.checked ?? false} onChange={() => toggleItem(item.id, item.checked ?? false)} aria-label={`Mark ${item.display ?? "item"} as done`} />
                    <span className="shopping-item-text">{item.display ?? `${item.quantity ?? ""} ${item.note ?? ""}`.trim()}</span>
                    <button type="button" className="shopping-item-remove btn-ghost btn-sm" onClick={() => removeItem(item.id)} aria-label="Remove item">
                      <X />
                    </button>
                  </li>
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

function toDateKey(date: Date): string {
  return date.toISOString().split('T')[0] as string
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

function MealPlanPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [view, setView] = useState<MealPlanView>(() => getStoredMealPlanView())
  const [anchorDate, setAnchorDate] = useState(() => new Date())
  const [entries, setEntries] = useState<MealieWeekPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pickerTarget, setPickerTarget] = useState<{ date: string; mealType: PlannableMealType; replaceEntryId?: string } | null>(null)

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
      setError(err instanceof Error ? err.message : 'Failed to remove that recipe from the meal plan.')
    }
  }

  const addRecipeToSlot = async (date: string, mealType: PlannableMealType, recipe: MealieRecipeSummary, replaceEntryId?: string) => {
    if (!activeProfile) return
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setError('')
    try {
      if (replaceEntryId) {
        await client.deleteMealPlanEntry(replaceEntryId)
        setEntries((current) => current.filter((entry) => entry.id !== replaceEntryId))
      }
      const created = await client.createMealPlanEntry({ date, entryType: mealType, title: recipe.name, recipeId: recipe.id })
      setEntries((current) => [...current, created])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add that recipe to the meal plan.')
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
                <button type="button" className="btn-ghost btn-sm" onClick={goPrevious} aria-label="Previous">prev</button>
                <button type="button" className="btn-ghost btn-sm" onClick={goToday}>Today</button>
                <button type="button" className="btn-ghost btn-sm" onClick={goNext} aria-label="Next">next</button>
              </div>
            </div>

            {error ? <p className="error-message">{error}</p> : null}
            {loading ? <p style={{color:'var(--text-muted)'}}>Loading meal plans...</p> : null}

            {view === 'day' ? (
              <MealPlanDayView date={anchorDate} slotsFor={slotsFor} onAddRecipe={(mealType) => setPickerTarget({ date: toDateKey(anchorDate), mealType })} onRemove={removeEntry} onReplace={(mealType, entry) => setPickerTarget({ date: toDateKey(anchorDate), mealType, replaceEntryId: entry.id })} />
            ) : null}
            {view === 'week' ? (
              <MealPlanWeekView weekStart={rangeStart} slotsFor={slotsFor} onAddRecipe={(date, mealType) => setPickerTarget({ date, mealType })} onRemove={removeEntry} onReplace={(date, mealType, entry) => setPickerTarget({ date, mealType, replaceEntryId: entry.id })} onOpenDay={(date) => { setAnchorDate(parseDateKey(date)); setView('day') }} />
            ) : null}
            {view === 'month' ? (
              <MealPlanMonthView monthStart={rangeStart} slots={slots} onOpenDay={(date) => { setAnchorDate(parseDateKey(date)); setView('day') }} />
            ) : null}
          </>
        )}

        {pickerTarget && activeProfile ? (
          <RecipePickerModal activeProfile={activeProfile} title={pickerTarget.replaceEntryId ? 'Replace recipe' : `Add a recipe to ${MEAL_TYPE_LABELS[pickerTarget.mealType] ?? pickerTarget.mealType}`} onSelect={(recipe) => void addRecipeToSlot(pickerTarget.date, pickerTarget.mealType, recipe, pickerTarget.replaceEntryId)} onClose={() => setPickerTarget(null)} />
        ) : null}
      </main>
    </div>
  )
}

function MealSlotCard({ mealType, entries, onAddRecipe, onRemove, onReplace }: {
  mealType: PlannableMealType
  entries: MealieWeekPlan[]
  onAddRecipe: () => void
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
            <span className="meal-slot-recipe-name">{entry.recipe?.name ?? entry.title ?? 'Untitled meal'}</span>
            <div className="meal-slot-recipe-actions">
              {entry.recipe?.slug ? <Link className="meal-slot-action-link" to={`/recipes/${entry.recipe.slug}`}>View</Link> : null}
              <button type="button" className="meal-slot-action-link" onClick={() => onReplace(entry)}>Replace</button>
              <button type="button" className="meal-slot-action-link" style={{color:'var(--danger)'}} onClick={() => onRemove(entry.id)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="btn-ghost btn-sm" onClick={onAddRecipe}><Plus /> Add</button>
    </div>
  )
}

function MealPlanDayView({ date, slotsFor, onAddRecipe, onRemove, onReplace }: {
  date: Date
  slotsFor: (dateKey: string, mealType: PlannableMealType) => MealieWeekPlan[]
  onAddRecipe: (mealType: PlannableMealType) => void
  onRemove: (entryId: string) => void
  onReplace: (mealType: PlannableMealType, entry: MealieWeekPlan) => void
}) {
  const dateKey = toDateKey(date)
  return (
    <section>
      <h2 className="meal-plan-day-heading">
        <span className="meal-plan-day-heading-name">{date.toLocaleDateString(undefined, { weekday: 'long' })}</span>
        <span className="meal-plan-day-heading-date">{date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
      </h2>
      <div className="meal-plan-day-slots">
        {PLANNABLE_MEAL_TYPES.map((mealType) => (
          <MealSlotCard key={mealType} mealType={mealType} entries={slotsFor(dateKey, mealType)} onAddRecipe={() => onAddRecipe(mealType)} onRemove={onRemove} onReplace={(entry) => onReplace(mealType, entry)} />
        ))}
      </div>
    </section>
  )
}

function MealPlanWeekView({ weekStart, slotsFor, onAddRecipe, onRemove, onReplace, onOpenDay }: {
  weekStart: Date
  slotsFor: (dateKey: string, mealType: PlannableMealType) => MealieWeekPlan[]
  onAddRecipe: (date: string, mealType: PlannableMealType) => void
  onRemove: (entryId: string) => void
  onReplace: (date: string, mealType: PlannableMealType, entry: MealieWeekPlan) => void
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
              {PLANNABLE_MEAL_TYPES.map((mealType) => (
                <MealSlotCard key={mealType} mealType={mealType} entries={slotsFor(dateKey, mealType)} onAddRecipe={() => onAddRecipe(dateKey, mealType)} onRemove={onRemove} onReplace={(entry) => onReplace(dateKey, mealType, entry)} />
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
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
    const names = slot.entries.map((entry) => entry.recipe?.name ?? entry.title ?? 'Untitled')
    const label = mealType === 'breakfast' ? 'B' : mealType === 'lunch' ? 'L' : 'D'
    return `${label}: ${names.join(", ")}`
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

function RecipePickerModal({ activeProfile, title, onSelect, onClose }: {
  activeProfile: MealieProfile
  title: string
  onSelect: (recipe: MealieRecipeSummary) => void
  onClose: () => void
}) {
  useModalEscapeToClose(onClose)
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState<MealieCategory[]>([])
  const [tags, setTags] = useState<MealieTag[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [tagId, setTagId] = useState('')
  const [recipes, setRecipes] = useState<MealieRecipeSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    client.getCategories().then(setCategories).catch(() => undefined)
    client.getTags().then(setTags).catch(() => undefined)
  }, [activeProfile])

  useEffect(() => {
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
  }, [activeProfile, search, categoryId, tagId])

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-panel recipe-picker-panel">
        <h3>{title}</h3>
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
          {!loading && recipes.length === 0 ? <li className="meal-slot-empty">No recipes match.</li> : null}
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <button type="button" className="recipe-picker-result" onClick={() => onSelect(recipe)}>{recipe.name}</button>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        </div>
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

function matchesIngredients(detail: MealieRecipeDetail, ingredients: string[], mode: 'any' | 'all'): boolean {
  if (ingredients.length === 0) return true
  const recipeIngredientText = (detail.ingredients ?? []).map((ingredient) => `${ingredient.food ?? ""} ${ingredient.note ?? ""}`.toLowerCase()).join(" | ")
  const haystackHas = (needle: string) => recipeIngredientText.includes(needle.toLowerCase().trim())
  return mode === 'all' ? ingredients.every((needle) => haystackHas(needle)) : ingredients.some((needle) => haystackHas(needle))
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
  const [ingredientInput, setIngredientInput] = useState('')
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
  const addIngredient = () => {
    const value = ingredientInput.trim()
    if (!value) return
    setIngredients((current) => (current.includes(value) ? current : [...current, value]))
    setIngredientInput('')
  }
  const removeIngredient = (value: string) => { setIngredients((current) => current.filter((item) => item !== value)) }
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
      const candidates = await client.getAllRecipes({ categories: categoryId ? [categoryId] : undefined, tags: tagIds.length > 0 ? tagIds : undefined, maxPrepTime, maxCookTime })
      let pool: RouletteResultRecipe[] = candidates
      if (ingredients.length > 0) {
        const details = await Promise.allSettled(candidates.map((recipe) => client.getRecipe(recipe.slug || recipe.id)))
        pool = candidates.filter((_recipe, index) => {
          const detailResult = details[index]
          if (detailResult.status !== 'fulfilled') return false
          return matchesIngredients(detailResult.value, ingredients, ingredientMode)
        })
      }
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
              <p className="page-intro-text">Do not know what to cook? Roll completely at random, or narrow it down below.</p>
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
                <div className="roulette-ingredient-input">
                  <input type="text" value={ingredientInput} onChange={(event) => setIngredientInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addIngredient() } }} placeholder="Chicken, rice, garlic..." aria-label="Add an ingredient you have on hand" />
                  <button type="button" className="btn-secondary btn-sm" onClick={addIngredient}>Add</button>
                </div>
                {ingredients.length > 0 ? (
                  <div className="chip-list" style={{marginTop:'var(--sp-2)'}}>
                    {ingredients.map((ingredient) => (
                      <button key={ingredient} type="button" className="chip active" onClick={() => removeIngredient(ingredient)} aria-label={`Remove ${ingredient}`}>{ingredient} <X size={12} /></button>
                    ))}
                  </div>
                ) : null}
                {ingredients.length > 0 ? (
                  <div className="roulette-ingredient-mode" role="radiogroup" aria-label="Ingredient matching mode">
                    <button type="button" className={ingredientMode === 'any' ? 'chip active' : 'chip'} onClick={() => setIngredientMode('any')} aria-pressed={ingredientMode === 'any'}>Match ANY</button>
                    <button type="button" className={ingredientMode === 'all' ? 'chip active' : 'chip'} onClick={() => setIngredientMode('all')} aria-pressed={ingredientMode === 'all'}>Match ALL</button>
                  </div>
                ) : null}
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
                {activeProfile ? <RecipeThumbnail activeProfile={activeProfile} recipe={result} className="roulette-result-image" /> : null}
                <div className="roulette-result-body">
                  <p className="eyebrow">Tonight s recipe</p>
                  <h2>{result.name}</h2>
                  {result.description ? <p>{result.description}</p> : null}
                  <div className="chip-list" style={{marginTop:'var(--sp-3)'}}>
                    {(result.categories ?? []).map((category) => <span key={category.id} className="chip">{category.name}</span>)}
                    {(result.tags ?? []).map((tag) => <span key={tag.id} className="chip">{tag.name}</span>)}
                    {result.prepTime ? <span className="chip">Prep: {result.prepTime} min</span> : null}
                    {result.cookTime ? <span className="chip">Cook: {result.cookTime} min</span> : null}
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
  const [date, setDate] = useState(new Date().toISOString().split('T')[0] as string)
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

function AddIngredientsToShoppingListModal({ activeProfile, recipeId, recipeName, onClose }: {
  activeProfile: MealieProfile
  recipeId: string
  recipeName: string
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
      const updated = await client.addRecipeIngredientsToShoppingList(targetListId, recipeId)
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
            <p style={{color:'var(--text-secondary)', fontSize:'0.9rem', marginBottom:'var(--sp-4)'}}>{recipeName}</p>
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




