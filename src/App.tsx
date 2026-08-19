import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { App as CapacitorApp } from '@capacitor/app'
import { KeepAwake } from '@capacitor-community/keep-awake'
import type { PluginListenerHandle } from '@capacitor/core'
import { Network } from '@capacitor/network'
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

function ExternalLink({
  href,
  children,
  className,
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isExternalHttpUrl(href)) return
    if (!isNativePlatform()) return
    event.preventDefault()
    await openExternalUrl(href)
  }

  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => void handleClick(event)}
    >
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

function AppHeader({ activeProfile, showHomeButton = true }: { activeProfile: MealieProfile | null; showHomeButton?: boolean }) {
  const location = useLocation()
  const isSettingsPage = location.pathname === '/settings'

  return (
    <header className="app-header">
      <div className="app-header-top">
        <div className="app-header-leading">
          {activeProfile && !isSettingsPage ? (
            <Link className="header-settings-button" to="/settings" aria-label="Open settings">
              <span className="header-settings-icon" aria-hidden="true">⚙</span>
              <span className="header-settings-label">Settings</span>
            </Link>
          ) : (
            <span className="header-action-spacer" aria-hidden="true" />
          )}
        </div>
        <div className="brand-cluster">
          <Link className="brand-lockup compact" to="/" aria-label="Mealie Connect home">
            <img className="brand-logo" src="/mealie-connect-logo.svg" alt="" />
            <span>Mealie Connect</span>
          </Link>
          {activeProfile ? (
            <Link className="header-profile-link" to="/setup">
              <span className="account-dot" aria-hidden="true" />
              <span>{activeProfile.displayName ?? activeProfile.username ?? 'Account'}</span>
            </Link>
          ) : null}
        </div>
        <div className="app-header-trailing">
          <Link className="header-import-button" to="/import" aria-label="Import a recipe" title="Import a recipe">+</Link>
        </div>
      </div>
      {activeProfile ? (
        <nav className={showHomeButton ? 'main-nav has-home' : 'main-nav'} aria-label="Primary navigation">
          {showHomeButton ? <Link to="/">Home</Link> : null}
          <Link to="/recipes">Recipes</Link>
          <Link to="/roulette">Dinner Roulette</Link>
          <Link to="/meal-plan">Meal plan</Link>
          <Link to="/shopping">Shopping list</Link>
        </nav>
      ) : null}
    </header>
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
          className={`theme-swatch-button${current === theme.id ? ' active' : ''}`}
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

function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  )
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

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  useEffect(() => {
    if (!isNativePlatform()) return

    let statusListener: PluginListenerHandle | undefined
    let mounted = true

    const initializeNetwork = async () => {
      const status = await Network.getStatus()
      if (mounted) {
        setNetworkConnected(status.connected)
      }
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
    return () => {
      void removeNativeListener(backButtonListener)
    }
  }, [])

  useEffect(() => {
    if (!isNativePlatform()) return

    if (!networkConnected) {
      setConnectivityState('offline')
      return
    }

    if (!activeProfile) {
      setConnectivityState('online')
      return
    }

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
    return () => {
      cancelled = true
    }
  }, [activeProfile, networkConnected])

  useEffect(() => {
    if (!activeProfile) {
      setRecipes([])
      setCategories([])
      setTags([])
      setHasMoreRecipes(false)
      return
    }

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    const timeout = window.setTimeout(async () => {
      setLoading(true)
      setError('')

      try {
        const results = await Promise.allSettled([
          client.getRecipes({
            search: searchTerm,
            categories: selectedCategories,
            tags: selectedTags,
            page: 1,
            perPage: RECIPES_PAGE_SIZE,
          }),
          client.getCategories(),
          client.getTags(),
        ])

        // Extract results, using empty arrays as fallback for failures
        const nextRecipes = results[0]?.status === 'fulfilled' ? results[0].value : []
        const nextCategories = results[1]?.status === 'fulfilled' ? results[1].value : []
        const nextTags = results[2]?.status === 'fulfilled' ? results[2].value : []

        setRecipes(nextRecipes)
        setHasMoreRecipes(nextRecipes.length === RECIPES_PAGE_SIZE)
        setCategories(nextCategories)
        setTags(nextTags)

        // If recipes failed to load, show error
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

  const signIn = async (
    server: string,
    method: AuthMethod,
    username?: string,
    password?: string,
    token?: string,
  ) => {
    const profile = await authService.signIn({
      server,
      method,
      username,
      password,
      token,
    })
    await loadProfiles()
    setActiveProfile(profile)
  }

  const signOut = () => {
    authService.signOut()
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
        <Route
          path="/"
          element={
            <HomePage
              activeProfile={activeProfile}
              recipes={recipes}
              loading={loading}
              error={error}
            />
          }
        />
        <Route
          path="/settings"
          element={
            <SettingsPage
              activeProfile={activeProfile}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onSignOut={signOut}
            />
          }
        />
        <Route
          path="/setup"
          element={<SetupPage onSignIn={signIn} profiles={profiles} onBack={() => window.history.back()} />}
        />
        <Route path="/import" element={<ImportRecipePage activeProfile={activeProfile} />} />
        <Route
          path="/recipes"
          element={
            <RecipesPage
              activeProfile={activeProfile}
              recipes={recipes}
              categories={categories}
              tags={tags}
              searchTerm={searchTerm}
              setSearchTerm={setSearchTerm}
              selectedCategories={selectedCategories}
              setSelectedCategories={setSelectedCategories}
              selectedTags={selectedTags}
              setSelectedTags={setSelectedTags}
              loading={loading}
              loadingMore={loadingMoreRecipes}
              hasMore={hasMoreRecipes}
              onLoadMore={loadMoreRecipes}
              error={error}
            />
          }
        />
        <Route
          path="/recipes/:slug"
          element={<RecipeDetailPage activeProfile={activeProfile} />}
        />
        <Route
          path="/cook/:slug"
          element={<CookModePage activeProfile={activeProfile} />}
        />
        <Route
          path="/shopping"
          element={<ShoppingListsPage activeProfile={activeProfile} />}
        />
        <Route
          path="/shopping/:id"
          element={<ShoppingListDetailPage activeProfile={activeProfile} />}
        />
        <Route
          path="/meal-plan"
          element={<MealPlanPage activeProfile={activeProfile} />}
        />
        <Route
          path="/random-recipe"
          element={<RouletteRedirect />}
        />
        <Route
          path="/roulette"
          element={<DinnerRoulettePage activeProfile={activeProfile} />}
        />
      </Routes>
      <NativeConnectionStatus state={connectivityState} />
    </BrowserRouter>
  )
}

function HomePage({
  activeProfile,
  recipes,
  loading,
  error,
}: {
  activeProfile: MealieProfile | null
  recipes: MealieRecipeSummary[]
  loading: boolean
  error: string
}) {
  const overview = useMemo(() => recipes.slice(0, 4), [recipes])

  return (
    <main className="app-shell">
      <AppHeader activeProfile={activeProfile} showHomeButton={false} />

      <section className="home-intro">
        <p className="eyebrow">Your cooking space</p>
        <h1>{activeProfile ? 'What are you cooking this week?' : 'A calmer way to cook from your Mealie library starts here.'}</h1>
        <p className="intro-copy">
          {activeProfile ? 'Find something familiar, make a plan, or let dinner surprise you.' : 'Connect your self-hosted Mealie server and bring your recipes into focus.'}
        </p>
        {!activeProfile ? <Link className="primary-button" to="/setup">Connect to Mealie</Link> : null}
      </section>

      {activeProfile ? (
        <>
          <section className="home-feature roulette-feature">
            <div className="feature-copy">
              <p className="eyebrow">What should I cook?</p>
              <h2>🎲 Dinner Roulette</h2>
              <p>Don&rsquo;t know what to cook? Let Dinner Roulette choose. Roll completely at random, or narrow it down by category, time, tags, and what&rsquo;s already in your kitchen.</p>
              <Link className="primary-button" to="/roulette">Roll the Dice</Link>
            </div>
            <div className="feature-rule" aria-hidden="true" />
          </section>

          <section className="home-recent">
            <SectionHeading eyebrow="From your library" title="Recently synced recipes" action={<Link className="text-link" to="/recipes">View all recipes</Link>} />
            {loading ? <p>Loading recipes…</p> : error ? <p className="error-text">{error}</p> : null}
            {!loading && !error && overview.length === 0 ? (
              <p className="empty-copy">No recipes are available yet. Connect a Mealie account and sync your library.</p>
            ) : null}
            <div className="recipe-grid home-recipe-grid">
              {overview.map((recipe) => (
                <Link key={recipe.id} className="recipe-card" to={`/recipes/${recipe.slug || recipe.id}`}>
                  <RecipeThumbnail activeProfile={activeProfile} recipe={recipe} />
                  <div className="recipe-card-body">
                    <p className="recipe-card-kicker">{recipe.categories?.[0]?.name ?? 'From your collection'}</p>
                    <h3>{recipe.name}</h3>
                    <span>{recipe.totalTime ? `${recipe.totalTime} min` : 'Ready to cook'}</span>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          <section className="home-tools">
            <SectionHeading eyebrow="Make the week easier" title="Cooking tools" />
            <div className="tool-links">
              <Link className="tool-link tool-link-primary" to="/meal-plan"><span>Plan</span><strong>Map out your week</strong><small>Keep dinner from becoming a daily question.</small></Link>
              <Link className="tool-link" to="/shopping"><span>Organize</span><strong>Build a shopping list</strong><small>Turn what you want to cook into a useful list.</small></Link>
              <Link className="tool-link" to="/recipes"><span>Browse</span><strong>Search your recipes</strong><small>Find the right idea by name, category, or tag.</small></Link>
            </div>
          </section>

          <section className="import-strip">
            <div><p className="eyebrow">Bring something new home</p><h2>Import a recipe</h2><p>Paste a recipe URL to add it to your collection.</p></div>
            <Link className="secondary-button" to="/import">Open import</Link>
          </section>
        </>
      ) : (
        <section className="home-empty-preview">
          <div><p className="eyebrow">A place for your recipes</p><h2>Your library will live here.</h2><p>Once connected, your recent recipes, plans, and shopping lists will be ready from one quiet home base.</p></div>
          <div className="preview-lines" aria-hidden="true"><span /><span /><span /></div>
        </section>
      )}
    </main>
  )
}

function SettingsPage({
  activeProfile,
  profiles,
  onSelectProfile,
  onSignOut,
}: {
  activeProfile: MealieProfile | null
  profiles: MealieProfile[]
  onSelectProfile: (profile: MealieProfile) => void
  onSignOut: () => void
}) {
  if (!activeProfile) {
    return (
      <main className="app-shell narrow">
        <AppHeader activeProfile={null} />
        <section className="page-empty compact-empty">
          <p className="eyebrow">Preferences</p>
          <h1>Settings</h1>
          <p>No active Mealie account is connected.</p>
          <Link className="primary-button" to="/setup">Connect to Mealie</Link>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell narrow">
      <AppHeader activeProfile={activeProfile} />
      <section className="settings-page">
        <div className="settings-page-header">
          <p className="eyebrow">Preferences</p>
          <h1>Settings</h1>
        </div>

        <div className="settings-panel-grid">
          <div className="settings-block">
            <p className="eyebrow">Connection</p>
            <div className="settings-profile-summary">
              <strong>{activeProfile.displayName ?? activeProfile.username ?? 'Mealie user'}</strong>
              <span>{activeProfile.server}</span>
            </div>
            <div className="profile-list">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={`profile-item ${activeProfile.id === profile.id ? 'active' : ''}`}
                  onClick={() => onSelectProfile(profile)}
                >
                  {profile.displayName ?? profile.username ?? profile.name}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-block account-details-theme">
            <p className="eyebrow">Appearance</p>
            <ThemeMenu />
          </div>
        </div>

        <button type="button" className="text-button danger-text" onClick={onSignOut}>Sign out</button>
      </section>
    </main>
  )
}

function SetupPage({
  onSignIn,
  profiles,
  onBack,
}: {
  onSignIn: (
    server: string,
    method: AuthMethod,
    username?: string,
    password?: string,
    token?: string,
  ) => Promise<void>
  profiles: MealieProfile[]
  onBack: () => void
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
      if (!server) {
        throw new Error('Please enter a Mealie server URL.')
      }

      const url = new URL(server)
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('The server must use http or https.')
      }

      // Test connection first
      const testClient = new MealieClient({ baseUrl: server })
      const connectionTest = await testClient.testConnection()

      if (!connectionTest.ok) {
        setError(connectionTest.message)
        if (connectionTest.isCorsError) {
          setCorsErrorDetected(true)
        }
        return
      }

      if (method === 'password') {
        if (!username || !password) {
          throw new Error('Enter both a username and password.')
        }
        await onSignIn(server, method, username, password)
      } else {
        if (!token) {
          throw new Error('Enter a Mealie API token.')
        }
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
    <main className="app-shell narrow">
      <AppHeader activeProfile={profiles[0] ?? null} />
      <div className="detail-toolbar">
        <button type="button" className="text-button" onClick={onBack}>← Back</button>
      </div>
      <section className="setup-intro">
        <p className="eyebrow">Connect to Mealie</p>
        <h1>Bring your cooking space with you.</h1>
        <p className="intro-copy">Connect your self-hosted server to browse, plan, shop, and cook from one place.</p>
      </section>
      <section className="setup-form">
        <h2>Server connection</h2>

        <form onSubmit={handleSubmit} className="form-stack">
          <label>
            Server URL
            <input
              type="url"
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder="https://mealie.example.com"
            />
          </label>

          <div className="auth-methods">
            <label>
              <input
                type="radio"
                name="authMethod"
                checked={method === 'password'}
                onChange={() => setMethod('password')}
              />
              Username & Password
            </label>
            <label>
              <input
                type="radio"
                name="authMethod"
                checked={method === 'token'}
                onChange={() => setMethod('token')}
              />
              API Token
            </label>
          </div>

          {method === 'password' ? (
            <>
              <label>
                Username
                <input value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label>
              API token
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
            </label>
          )}

          {error ? (
            <div className={corsErrorDetected ? 'cors-error-box' : 'error-text'}>
              {error}
            </div>
          ) : null}

          {corsErrorDetected && (
            <section className="cors-solution-panel">
              <h3>CORS error: use the local proxy</h3>
              <div className="help-text">
                <p>
                  <strong>What's happening?</strong> Your browser is blocking the connection because your Mealie server
                  doesn't have CORS enabled. This is a security feature.
                </p>
                <p>
                  <strong>Quick Fix:</strong> Use the included CORS proxy
                </p>
                <ol className="proxy-steps">
                  <li>
                    Open a terminal in the Mealie Connect folder and run:
                    <code>node cors-proxy.js</code>
                  </li>
                  <li>You should see "Proxy is listening on http://localhost:3001"</li>
                  <li>In the URL field above, clear it and enter: <code>http://localhost:3001</code></li>
                  <li>Click Continue</li>
                </ol>
                <p className="small-text">
                  The proxy runs locally on your computer and forwards requests to your actual Mealie server while
                  adding the necessary CORS headers.
                </p>
                <p className="small-text">
                  In the Android app, Mealie requests use Capacitor&apos;s native HTTP bridge, so browser CORS rules do
                  not apply there. This proxy is only for the web app running in a browser.
                </p>
              </div>
            </section>
          )}

          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? 'Connecting…' : 'Continue'}
          </button>
        </form>
      </section>

      {profiles.length > 0 && (
        <section className="setup-secondary">
          <p className="eyebrow">Saved connections</p>
          <h2>Profiles on this device</h2>
          <div className="profile-list compact">
            {profiles.map((profile) => (
              <div key={profile.id} className="profile-summary">
                <strong>{profile.displayName ?? profile.username ?? profile.name}</strong>
                <span>{profile.server}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="setup-secondary">
        <p className="eyebrow">Need a hand?</p>
        <h2>Troubleshooting</h2>
        <div className="help-text">
          <p><strong>NetworkError or CORS error?</strong></p>
          <ul>
            <li>Check that your Mealie server URL is correct (include the protocol: http:// or https://)</li>
            <li>Verify your browser can reach the server (try opening the URL in a new tab)</li>
            <li>Ensure the Mealie server is running and accessible from your network</li>
            <li>If you are testing the web app in a browser, your Mealie server or reverse proxy must allow CORS for that browser origin</li>
            <li>Check browser console (F12) for detailed error messages</li>
            <li>If using a self-hosted server behind a reverse proxy, ensure CORS is properly configured</li>
          </ul>
          <p><strong>Authentication failed?</strong></p>
          <ul>
            <li>Double-check your username and password</li>
            <li>Ensure you're using the correct Mealie account</li>
            <li>Try resetting your password on the Mealie server if needed</li>
          </ul>
        </div>
      </section>
    </main>
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

    if (!activeProfile) {
      setError('Connect a Mealie account before importing a recipe.')
      return
    }

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
      setMessage(`Imported “${importedRecipe.name}”.`)
      navigate(`/recipes/${importedRecipe.slug || importedRecipe.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import recipe.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <main className="app-shell narrow">
      <AppHeader activeProfile={activeProfile} />
      <section className="setup-intro import-page-intro">
        <p className="eyebrow">Bring something new home</p>
        <h1>Import a recipe.</h1>
        <p className="intro-copy">Paste a recipe URL and add it to your Mealie collection.</p>
      </section>
      {!activeProfile ? (
        <section className="page-empty compact-empty">
          <p>No active Mealie account is connected.</p>
          <Link className="primary-button" to="/setup">Connect to Mealie</Link>
        </section>
      ) : (
        <section className="setup-form import-page-form">
          <form onSubmit={handleImport} className="form-stack">
            <label htmlFor="import-page-url">
              Recipe URL
              <input id="import-page-url" type="url" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://example.com/recipe" required />
            </label>
            {message ? <p className="success-text">{message}</p> : null}
            {error ? <p className="error-text">{error}</p> : null}
            <button type="submit" className="primary-button" disabled={importing}>{importing ? 'Importing…' : 'Import recipe'}</button>
          </form>
        </section>
      )}
    </main>
  )
}

function RecipesPage({
  activeProfile,
  recipes,
  categories,
  tags,
  searchTerm,
  setSearchTerm,
  selectedCategories,
  setSelectedCategories,
  selectedTags,
  setSelectedTags,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  error,
}: {
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

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore()
      },
      { rootMargin: '480px 0px' },
    )

    observer.observe(trigger)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore])

  useEffect(() => {
    setShowBackToTop(recipes.length >= RECIPES_PAGE_SIZE * 2)
  }, [recipes.length])

  const toggleCategory = (id: string) => {
    setSelectedCategories(
      selectedCategories.includes(id)
        ? selectedCategories.filter((value) => value !== id)
        : [...selectedCategories, id],
    )
  }

  const toggleTag = (id: string) => {
    setSelectedTags(
      selectedTags.includes(id) ? selectedTags.filter((value) => value !== id) : [...selectedTags, id],
    )
  }

  const activeFilterCount = selectedCategories.length + selectedTags.length
  const clearFilters = () => {
    setSelectedCategories([])
    setSelectedTags([])
  }

  return (
    <main className="app-shell">
      <AppHeader activeProfile={activeProfile} />

      {!activeProfile ? (
        <section className="page-empty">
          <p className="eyebrow">Recipe library</p>
          <h1>Your recipes are waiting.</h1>
          <p>No active Mealie account is connected.</p>
          <Link className="primary-button" to="/setup">
            Connect to Mealie
          </Link>
        </section>
      ) : (
        <>
          <section className="page-intro">
            <p className="eyebrow">Recipe library</p>
            <h1>Find something to cook.</h1>
            <p className="intro-copy">Search the recipes you have gathered, saved, and loved.</p>
            <Link className="secondary-button page-intro-action" to="/roulette">🎲 Dinner Roulette</Link>
          </section>

          <section className="library-controls">
            <div className="library-search-header">
              <div>
                <label className="sr-only" htmlFor="recipe-search">Search your recipes</label>
                <input
                  id="recipe-search"
                  type="search"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search recipes by name or ingredient…"
                />
              </div>
              <span className="result-count">{recipes.length} recipes</span>
            </div>

            <div className="filter-panel">
            <div className="filter-header">
              <div>
                <p className="eyebrow">Refine</p>
                <h2>Browse by mood</h2>
              </div>
              {activeFilterCount > 0 ? (
                <button type="button" className="clear-filters" onClick={clearFilters}>
                  Clear {activeFilterCount}
                </button>
              ) : null}
            </div>

            <div className="filter-group">
              <h4>Categories</h4>
              <label className="mobile-filter-label" htmlFor="mobile-category-filter">Category</label>
              <select
                id="mobile-category-filter"
                className="mobile-filter-select"
                value={selectedCategories[0] ?? ''}
                onChange={(event) => setSelectedCategories(event.target.value ? [event.target.value] : [])}
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
              <div className="chip-list">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={selectedCategories.includes(category.id) ? 'chip active' : 'chip'}
                    onClick={() => toggleCategory(category.id)}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <h4>Tags</h4>
              <label className="mobile-filter-label" htmlFor="mobile-tag-filter">Tag</label>
              <select
                id="mobile-tag-filter"
                className="mobile-filter-select"
                value={selectedTags[0] ?? ''}
                onChange={(event) => setSelectedTags(event.target.value ? [event.target.value] : [])}
              >
                <option value="">All tags</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>{tag.name}</option>
                ))}
              </select>
              <div className="chip-list">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className={selectedTags.includes(tag.id) ? 'chip active' : 'chip'}
                    onClick={() => toggleTag(tag.id)}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
            </div>
          </section>

          {loading ? <p>Loading recipes…</p> : null}
          {error ? <p className="error-text">{error}</p> : null}

          <section className="recipe-grid library-recipe-grid">
            {recipes.map((recipe) => (
              <article key={recipe.id} className="recipe-card library-recipe-card">
                <Link className="library-recipe-card-link" to={`/recipes/${recipe.slug || recipe.id}`}>
                  <RecipeThumbnail activeProfile={activeProfile} recipe={recipe} />
                  <div className="recipe-card-body">
                    <p className="recipe-card-kicker">{recipe.categories?.[0]?.name ?? 'From your collection'}</p>
                    <h3>{recipe.name}</h3>
                    <p>{recipe.description ?? 'A recipe ready for your table.'}</p>
                    <span>{recipe.totalTime ? `${recipe.totalTime} min` : 'Ready to cook'}</span>
                  </div>
                </Link>
                <Link className="recipe-card-action" to={`/cook/${recipe.slug || recipe.id}`}>
                  Cook this recipe
                </Link>
              </article>
            ))}
          </section>
          {hasMore ? (
            <div ref={loadMoreTrigger} className="recipe-load-more" aria-live="polite">
              {loadingMore ? 'Loading more recipes…' : 'Scroll for more recipes'}
            </div>
          ) : null}
          {showBackToTop ? (
            <button
              type="button"
              className="back-to-top"
              aria-label="Back to top"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              ↑ <span>Top</span>
            </button>
          ) : null}
        </>
      )}
    </main>
  )
}

function RecipeThumbnail({
  activeProfile,
  recipe,
  className = 'recipe-thumbnail',
}: {
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
    client
      .loadRecipeImage(sourceUrl)
      .then((nextImageUrl) => {
        if (disposed) {
          URL.revokeObjectURL(nextImageUrl)
          return
        }
        setImageUrl(nextImageUrl)
      })
      .catch(() => setImageUrl(''))

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

function RecipeDetailPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { slug } = useParams()
  const [recipe, setRecipe] = useState<MealieRecipeDetail | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showShoppingModal, setShowShoppingModal] = useState(false)
  const [showMealPlanModal, setShowMealPlanModal] = useState(false)

  useEffect(() => {
    if (!activeProfile || !slug) {
      setRecipe(null)
      return
    }

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setLoading(true)
    setError('')
    setImageUrl('')

    client
      .getRecipe(slug)
      .then(async (nextRecipe) => {
        setRecipe(nextRecipe)
        if (nextRecipe.image) {
          try {
            setImageUrl(await client.loadRecipeImage(nextRecipe.image))
          } catch {
            setImageUrl('')
          }
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))

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
    <main className="app-shell detail-shell">
      <AppHeader activeProfile={activeProfile} />

      <div className="detail-toolbar">
        <Link className="text-link" to="/recipes">← Back to recipes</Link>
        {recipe ? <Link className="primary-button" to={`/cook/${recipe.slug || recipe.id}`}>Cook this recipe</Link> : null}
      </div>

      {loading ? <p>Loading recipe…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!recipe && !loading && !error ? <p>No recipe found.</p> : null}

      {recipe ? (
        <>
          <section className="detail-hero with-image">
            <img className="detail-image" src={imageUrl || defaultRecipeImage} alt={imageUrl ? recipe.name : ''} />
            <div className="detail-summary">
              <p className="eyebrow">Recipe detail</p>
              <h2>{recipe.name}</h2>
              <p>{recipe.description ?? 'No description provided.'}</p>
              <div className="meta-row detail-meta">
                <span>{recipe.categories?.[0]?.name ?? 'Uncategorized'}</span>
                {recipe.totalTime ? <span>{recipe.totalTime} min total</span> : null}
                {recipe.prepTime ? <span>{recipe.prepTime} prep</span> : null}
                {recipe.cookTime ? <span>{recipe.cookTime} cook</span> : null}
                {recipe.servings ? <span>{recipe.servings} servings</span> : null}
              </div>
              {recipe.url ? (
                <ExternalLink className="text-link" href={recipe.url}>
                  Open original recipe source
                </ExternalLink>
              ) : null}
              <div className="recipe-detail-actions">
                <button type="button" className="secondary-button" onClick={() => setShowShoppingModal(true)}>Add Ingredients to Shopping List</button>
                <button type="button" className="secondary-button" onClick={() => setShowMealPlanModal(true)}>Add to Meal Plan</button>
              </div>
            </div>
          </section>

          <section className="content-section">
            <SectionHeading eyebrow="Gather everything" title="Ingredients" />
            <ul className="ingredient-list">
              {ingredients.length > 0 ? (
                ingredients.map((ingredient, index) => {
                  const ingredientText =
                    ingredient.display ??
                    ingredient.note ??
                    `${ingredient.quantity ?? ''} ${ingredient.unit ?? ''} ${ingredient.food ?? ingredient.name ?? ''}`.trim()

                  return <li key={`${ingredient.id ?? 'ingredient'}-${index}`}>{ingredientText}</li>
                })
              ) : (
                <li>No ingredients listed.</li>
              )}
            </ul>
          </section>

          <section className="content-section">
            <SectionHeading eyebrow="Take it step by step" title="Instructions" />
            <div className="instruction-list">
              {steps.length > 0 ? (
                steps.map((step, index) => (
                  <div key={`${step.id ?? 'step'}-${index}`} className="instruction-card">
                    <span className="step-badge">Step {index + 1}</span>
                    <p>{step.text ?? step.instruction ?? `Step ${index + 1}`}</p>
                  </div>
                ))
              ) : (
                <p>No instructions available.</p>
              )}
            </div>
          </section>
        </>
      ) : null}

      {recipe && showShoppingModal && activeProfile ? (
        <AddIngredientsToShoppingListModal
          activeProfile={activeProfile}
          recipeId={recipe.id}
          recipeName={recipe.name}
          onClose={() => setShowShoppingModal(false)}
        />
      ) : null}

      {recipe && showMealPlanModal && activeProfile ? (
        <AddToMealPlanModal
          activeProfile={activeProfile}
          recipe={recipe}
          onClose={() => setShowMealPlanModal(false)}
        />
      ) : null}
    </main>
  )
}

function CookModePage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { slug } = useParams()
  const [recipe, setRecipe] = useState<MealieRecipeDetail | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!activeProfile || !slug) {
      setRecipe(null)
      return
    }

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setLoading(true)
    setError('')

    client
      .getRecipe(slug)
      .then((nextRecipe) => {
        setRecipe(nextRecipe)
        setCurrentStep(0)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
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
    <main className="cook-shell">
      <AppHeader activeProfile={activeProfile} />
      <div className="cook-header">
        <Link className="text-link" to={recipe ? `/recipes/${recipe.slug || recipe.id}` : '/recipes'}>
          ← Return to recipe
        </Link>
      </div>

      {loading ? <p>Loading cook mode…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {recipe && current ? (
        <section className="cook-panel">
          <RecipeThumbnail activeProfile={activeProfile!} recipe={recipe} className="cook-thumbnail" />
          <p className="eyebrow">Cook Mode</p>
          <h2>{recipe.name}</h2>
          <p className="step-label">Step {currentStep + 1} of {steps.length}</p>

          <div className="progress-bar">
            <span style={{ width: `${((currentStep + 1) / steps.length) * 100}%` }} />
          </div>

          <div className="cook-card">
            <p>{current.text ?? current.instruction ?? `Step ${currentStep + 1}`}</p>
          </div>

          <div className="cook-actions">
            <button type="button" className="secondary-button" onClick={() => setCurrentStep((value) => Math.max(0, value - 1))} disabled={currentStep === 0}>
              ← Previous
            </button>
            <button type="button" className="primary-button" onClick={() => setCurrentStep((value) => Math.min(steps.length - 1, value + 1))} disabled={currentStep >= steps.length - 1}>
              Next →
            </button>
          </div>
        </section>
      ) : null}
    </main>
  )
}

function ShoppingListsPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [lists, setLists] = useState<MealieShoppingList[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [newListName, setNewListName] = useState('')

  useEffect(() => {
    if (!activeProfile) {
      setLists([])
      return
    }

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setLoading(true)
    setError('')

    client
      .getShoppingLists()
      .then((nextLists) => setLists(nextLists))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [activeProfile])

  const createNewList = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeProfile || !newListName.trim()) return

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

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

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    try {
      await client.deleteShoppingList(id)
      setLists(lists.filter((list) => list.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete list.')
    }
  }

  return (
    <main className="app-shell">
      <AppHeader activeProfile={activeProfile} />

      {!activeProfile ? (
        <section className="page-empty">
          <p className="eyebrow">Shopping lists</p>
          <h1>Keep the kitchen moving.</h1>
          <p>No active Mealie account is connected.</p>
          <Link className="primary-button" to="/setup">
            Connect to Mealie
          </Link>
        </section>
      ) : (
        <>
          <section className="page-intro">
            <p className="eyebrow">Shopping lists</p>
            <h1>Bring the ingredients together.</h1>
            <p className="intro-copy">Keep the next trip to the market focused and easy to act on.</p>
          </section>

          <section className="task-form">
            <form onSubmit={createNewList} className="form-stack">
              <label>
                Create a new list
                <input
                  type="text"
                  value={newListName}
                  onChange={(event) => setNewListName(event.target.value)}
                  placeholder="Grocery shopping, Dinner party, etc."
                />
              </label>
              <button type="submit" className="primary-button">
                Create List
              </button>
            </form>
          </section>

          {error ? <p className="error-text">{error}</p> : null}
          {loading ? <p>Loading shopping lists…</p> : null}

          {lists.length === 0 && !loading ? (
            <section className="page-empty compact-empty">
              <p>No shopping lists yet. Create one to get started!</p>
            </section>
          ) : (
            <section className="list-stack">
              {lists.map((list) => (
                <article key={list.id} className="list-row">
                  <div className="recipe-card-body">
                    <div className="recipe-card-header">
                      <div>
                        <h3>{list.name}</h3>
                        <p>{(list.items ?? []).length} items</p>
                      </div>
                      <div className="list-row-actions">
                        <Link className="secondary-button small-button" to={`/shopping/${list.id}`}>
                          Open
                        </Link>
                        <button
                          type="button"
                          onClick={() => deleteList(list.id)}
                          className="secondary-button small-button danger-action"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </main>
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
    if (!activeProfile || !id) {
      setList(null)
      return
    }

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setLoading(true)
    setError('')

    client
      .getShoppingList(id)
      .then((nextList) => setList(nextList))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [activeProfile, id])

  const addItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeProfile || !list || !newItemFood.trim()) return

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    try {
      const updated = await client.addToShoppingList(list.id, {
        quantity: newItemQuantity || undefined,
        unit: newItemUnit || undefined,
        food: newItemFood,
      })
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

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    try {
      const updated = await client.updateShoppingListItem(list.id, itemId, { checked: !checked })
      setList(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update item.')
    }
  }

  const removeItem = async (itemId: string | undefined) => {
    if (!activeProfile || !list || !itemId) return

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    try {
      await client.removeFromShoppingList(list.id, itemId)
      setList({
        ...list,
        items: list.items?.filter((item) => item.id !== itemId),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove item.')
    }
  }

  const removeAllItems = async () => {
    if (!activeProfile || !list) return

    const itemIds = (list.items ?? []).map((item) => item.id).filter((itemId): itemId is string => Boolean(itemId))
    if (itemIds.length === 0) return

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setError('')
    try {
      const updated = await client.removeAllFromShoppingList(list.id, itemIds)
      setList(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove all items.')
    }
  }

  return (
    <main className="app-shell detail-shell">
      <AppHeader activeProfile={activeProfile} />

      <div className="detail-toolbar">
        <Link className="text-link" to="/shopping">← Back to lists</Link>
      </div>

      {loading ? <p>Loading shopping list…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!list && !loading && !error ? <p>No list found.</p> : null}

      {list ? (
        <>
          <section className="page-intro detail-page-intro">
            <p className="eyebrow">Shopping list</p>
            <h1>{list.name}</h1>
            <p className="intro-copy">Add what you need, then check things off as you shop.</p>
          </section>

          <section className="task-form">
            <form onSubmit={addItem} className="form-stack">
              <div className="shopping-add-grid">
                <label>
                  Quantity
                  <input
                    type="text"
                    value={newItemQuantity}
                    onChange={(event) => setNewItemQuantity(event.target.value)}
                    placeholder="2"
                  />
                </label>
                <label>
                  Unit
                  <input
                    type="text"
                    value={newItemUnit}
                    onChange={(event) => setNewItemUnit(event.target.value)}
                    placeholder="cups"
                  />
                </label>
                <label>
                  Item
                  <input
                    type="text"
                    value={newItemFood}
                    onChange={(event) => setNewItemFood(event.target.value)}
                    placeholder="Flour"
                  />
                </label>
              </div>
              <button type="submit" className="primary-button">
                Add Item
              </button>
            </form>
          </section>

          <section className="content-section shopping-content-section">
            <SectionHeading
              eyebrow={`${(list.items ?? []).length} to gather`}
              title="Items"
              action={
                (list.items ?? []).length > 0 ? (
                  <button type="button" className="secondary-button danger-action" onClick={() => void removeAllItems()}>
                    Remove All
                  </button>
                ) : undefined
              }
            />
            <div className="instruction-list">
              {(list.items ?? []).length > 0 ? (
                (list.items ?? []).map((item, index) => (
                  <div key={`${item.id ?? 'item'}-${index}`} className={`shopping-item${item.checked ? ' checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={item.checked ?? false}
                      onChange={() => toggleItem(item.id, item.checked ?? false)}
                    />
                    <div className="shopping-item-copy">
                      <p>
                        {item.display ?? `${item.quantity ?? ''} ${item.unit ?? ''} ${item.food ?? ''}`.trim()}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="secondary-button small-button"
                      onClick={() => removeItem(item.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))
              ) : (
                <p>No items in this list.</p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

function toDateKey(date: Date): string {
  return date.toISOString().split('T')[0]
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1)
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
    if (view === 'day') {
      return { rangeStart: new Date(anchorDate), rangeEnd: new Date(anchorDate) }
    }
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
    if (!activeProfile) {
      setEntries([])
      return
    }

    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setLoading(true)
    setError('')

    client
      .getMealPlans(toDateKey(rangeStart), toDateKey(rangeEnd))
      .then((nextEntries) => setEntries(nextEntries))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [activeProfile, rangeStart, rangeEnd])

  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  const slots = useMemo(() => groupMealPlanEntriesIntoSlots(entries), [entries])

  const slotsFor = useCallback(
    (dateKey: string, mealType: PlannableMealType) =>
      slots.find((slot) => slot.date === dateKey && slot.entryType === mealType)?.entries ?? [],
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
      const created = await client.createMealPlanEntry({
        date,
        entryType: mealType,
        title: recipe.name,
        recipeId: recipe.id,
      })
      setEntries((current) => [...current, created])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add that recipe to the meal plan.')
    } finally {
      setPickerTarget(null)
    }
  }

  const goToday = () => setAnchorDate(new Date())
  const goPrevious = () =>
    setAnchorDate((current) => {
      if (view === 'day') return new Date(current.getTime() - DAY_MS)
      if (view === 'week') return new Date(current.getTime() - 7 * DAY_MS)
      return new Date(current.getFullYear(), current.getMonth() - 1, 1)
    })
  const goNext = () =>
    setAnchorDate((current) => {
      if (view === 'day') return new Date(current.getTime() + DAY_MS)
      if (view === 'week') return new Date(current.getTime() + 7 * DAY_MS)
      return new Date(current.getFullYear(), current.getMonth() + 1, 1)
    })

  return (
    <main className="app-shell">
      <AppHeader activeProfile={activeProfile} />

      {!activeProfile ? (
        <section className="page-empty">
          <p className="eyebrow">Meal planning</p>
          <h1>Make room for good dinners.</h1>
          <p>No active Mealie account is connected.</p>
          <Link className="primary-button" to="/setup">
            Connect to Mealie
          </Link>
        </section>
      ) : (
        <>
          <section className="page-intro">
            <p className="eyebrow">Meal planning</p>
            <h1>Plan the week with less guesswork.</h1>
            <p className="intro-copy">Put a little shape around the days ahead, one meal at a time.</p>
          </section>

          <div className="meal-plan-toolbar">
            <div className="view-switcher" role="tablist" aria-label="Meal plan view">
              {(['day', 'week', 'month'] as MealPlanView[]).map((viewOption) => (
                <button
                  key={viewOption}
                  type="button"
                  role="tab"
                  aria-selected={view === viewOption}
                  className={`view-switcher-button${view === viewOption ? ' active' : ''}`}
                  onClick={() => setView(viewOption)}
                >
                  {viewOption === 'day' ? 'Day' : viewOption === 'week' ? 'Week' : 'Month'}
                </button>
              ))}
            </div>
            <div className="date-nav">
              <button type="button" className="secondary-button small-button" onClick={goPrevious} aria-label="Previous">‹ Previous</button>
              <button type="button" className="secondary-button small-button" onClick={goToday}>Today</button>
              <button type="button" className="secondary-button small-button" onClick={goNext} aria-label="Next">Next ›</button>
            </div>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
          {loading ? <p>Loading meal plans…</p> : null}

          {view === 'day' ? (
            <MealPlanDayView
              date={anchorDate}
              slotsFor={slotsFor}
              onAddRecipe={(mealType) => setPickerTarget({ date: toDateKey(anchorDate), mealType })}
              onRemove={removeEntry}
              onReplace={(mealType, entry) => setPickerTarget({ date: toDateKey(anchorDate), mealType, replaceEntryId: entry.id })}
            />
          ) : null}

          {view === 'week' ? (
            <MealPlanWeekView
              weekStart={rangeStart}
              slotsFor={slotsFor}
              onAddRecipe={(date, mealType) => setPickerTarget({ date, mealType })}
              onRemove={removeEntry}
              onReplace={(date, mealType, entry) => setPickerTarget({ date, mealType, replaceEntryId: entry.id })}
              onOpenDay={(date) => {
                setAnchorDate(parseDateKey(date))
                setView('day')
              }}
            />
          ) : null}

          {view === 'month' ? (
            <MealPlanMonthView
              monthStart={rangeStart}
              slots={slots}
              onOpenDay={(date) => {
                setAnchorDate(parseDateKey(date))
                setView('day')
              }}
            />
          ) : null}
        </>
      )}

      {pickerTarget && activeProfile ? (
        <RecipePickerModal
          activeProfile={activeProfile}
          title={pickerTarget.replaceEntryId ? 'Replace recipe' : `Add a recipe to ${MEAL_TYPE_LABELS[pickerTarget.mealType]}`}
          onSelect={(recipe) => void addRecipeToSlot(pickerTarget.date, pickerTarget.mealType, recipe, pickerTarget.replaceEntryId)}
          onClose={() => setPickerTarget(null)}
        />
      ) : null}
    </main>
  )
}

function MealSlotCard({
  mealType,
  entries,
  onAddRecipe,
  onRemove,
  onReplace,
}: {
  mealType: PlannableMealType
  entries: MealieWeekPlan[]
  onAddRecipe: () => void
  onRemove: (entryId: string) => void
  onReplace: (entry: MealieWeekPlan) => void
}) {
  return (
    <div className="meal-slot-card">
      <h4 className="meal-slot-heading">{MEAL_TYPE_LABELS[mealType]}</h4>
      {entries.length === 0 ? <p className="meal-slot-empty">Nothing planned yet.</p> : null}
      <ul className="meal-slot-recipe-list">
        {entries.map((entry) => (
          <li key={entry.id} className="meal-slot-recipe">
            <span className="meal-slot-recipe-name">{entry.recipe?.name ?? entry.title ?? 'Untitled meal'}</span>
            <div className="meal-slot-recipe-actions">
              {entry.recipe?.slug ? (
                <Link className="text-link small-link" to={`/recipes/${entry.recipe.slug}`}>View</Link>
              ) : null}
              <button type="button" className="text-button small-link" onClick={() => onReplace(entry)}>Replace</button>
              <button type="button" className="text-button danger-text small-link" onClick={() => onRemove(entry.id)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="secondary-button small-button add-recipe-button" onClick={onAddRecipe}>+ Add Recipe</button>
    </div>
  )
}

function MealPlanDayView({
  date,
  slotsFor,
  onAddRecipe,
  onRemove,
  onReplace,
}: {
  date: Date
  slotsFor: (dateKey: string, mealType: PlannableMealType) => MealieWeekPlan[]
  onAddRecipe: (mealType: PlannableMealType) => void
  onRemove: (entryId: string) => void
  onReplace: (mealType: PlannableMealType, entry: MealieWeekPlan) => void
}) {
  const dateKey = toDateKey(date)
  return (
    <section className="meal-plan-day-view">
      <h2 className="meal-plan-day-heading">
        {date.toLocaleDateString(undefined, { weekday: 'long' })}
        <span className="meal-plan-day-date">{date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</span>
      </h2>
      <div className="meal-plan-day-slots">
        {PLANNABLE_MEAL_TYPES.map((mealType) => (
          <MealSlotCard
            key={mealType}
            mealType={mealType}
            entries={slotsFor(dateKey, mealType)}
            onAddRecipe={() => onAddRecipe(mealType)}
            onRemove={onRemove}
            onReplace={(entry) => onReplace(mealType, entry)}
          />
        ))}
      </div>
    </section>
  )
}

function MealPlanWeekView({
  weekStart,
  slotsFor,
  onAddRecipe,
  onRemove,
  onReplace,
  onOpenDay,
}: {
  weekStart: Date
  slotsFor: (dateKey: string, mealType: PlannableMealType) => MealieWeekPlan[]
  onAddRecipe: (date: string, mealType: PlannableMealType) => void
  onRemove: (entryId: string) => void
  onReplace: (date: string, mealType: PlannableMealType, entry: MealieWeekPlan) => void
  onOpenDay: (date: string) => void
}) {
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => new Date(weekStart.getTime() + index * DAY_MS)),
    [weekStart],
  )

  return (
    <section className="meal-plan-week-view">
      {days.map((day) => {
        const dateKey = toDateKey(day)
        return (
          <div key={dateKey} className="meal-plan-week-day">
            <button type="button" className="meal-plan-week-day-heading" onClick={() => onOpenDay(dateKey)}>
              <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
              <span className="meal-plan-week-day-number">{day.getDate()}</span>
            </button>
            <div className="meal-plan-week-day-slots">
              {PLANNABLE_MEAL_TYPES.map((mealType) => (
                <MealSlotCard
                  key={mealType}
                  mealType={mealType}
                  entries={slotsFor(dateKey, mealType)}
                  onAddRecipe={() => onAddRecipe(dateKey, mealType)}
                  onRemove={onRemove}
                  onReplace={(entry) => onReplace(dateKey, mealType, entry)}
                />
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function MealPlanMonthView({
  monthStart,
  slots,
  onOpenDay,
}: {
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
    for (let day = 1; day <= daysInMonth; day += 1) {
      result.push(new Date(monthStart.getFullYear(), monthStart.getMonth(), day))
    }
    return result
  }, [firstDayOffset, daysInMonth, monthStart])

  const mealSummary = (mealType: PlannableMealType, daySlots: MealPlanSlot[]) => {
    const slot = daySlots.find((candidate) => candidate.entryType === mealType)
    if (!slot || slot.entries.length === 0) return null
    const names = slot.entries.map((entry) => entry.recipe?.name ?? entry.title ?? 'Untitled')
    const label = mealType === 'breakfast' ? 'B' : mealType === 'lunch' ? 'L' : 'D'
    return `${label}: ${names.join(' + ')}`
  }

  return (
    <section className="meal-plan-month-view">
      <h2 className="meal-plan-month-heading">
        {monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
      </h2>
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
              {summaries.map((summary) => (
                <span key={summary} className="meal-plan-month-summary">{summary}</span>
              ))}
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** A searchable recipe picker reusing the same search/category/tag filters as
 * the Recipes page, used by the meal planner's "+ Add Recipe" / "Replace" flows. */
function RecipePickerModal({
  activeProfile,
  title,
  onSelect,
  onClose,
}: {
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
      client
        .getRecipes({
          search: search.trim() || undefined,
          categories: categoryId ? [categoryId] : undefined,
          tags: tagId ? [tagId] : undefined,
        })
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
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search recipes…"
            aria-label="Search recipes"
          />
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
          <select value={tagId} onChange={(event) => setTagId(event.target.value)} aria-label="Filter by tag">
            <option value="">All tags</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
        </div>

        {error ? <p className="error-text">{error}</p> : null}
        {loading ? <p>Searching…</p> : null}

        <ul className="recipe-picker-results">
          {!loading && recipes.length === 0 ? <li className="meal-slot-empty">No recipes match.</li> : null}
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <button type="button" className="recipe-picker-result" onClick={() => onSelect(recipe)}>
                {recipe.name}
              </button>
            </li>
          ))}
        </ul>

        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** The old `/random-recipe` route now lives at `/roulette`; redirect for any
 * bookmarks or links still pointing at the previous path. */
function RouletteRedirect() {
  const navigate = useNavigate()
  useEffect(() => {
    navigate('/roulette', { replace: true })
  }, [navigate])
  return null
}

interface RouletteResultRecipe extends MealieRecipeSummary {
  __detail?: MealieRecipeDetail
}

function matchesIngredients(detail: MealieRecipeDetail, ingredients: string[], mode: 'any' | 'all'): boolean {
  if (ingredients.length === 0) return true

  const recipeIngredientText = (detail.ingredients ?? [])
    .map((ingredient) => `${ingredient.food ?? ingredient.name ?? ''} ${ingredient.display ?? ''} ${ingredient.note ?? ''}`.toLowerCase())
    .join(' | ')

  const haystackHas = (needle: string) => recipeIngredientText.includes(needle.toLowerCase().trim())

  return mode === 'all'
    ? ingredients.every((needle) => haystackHas(needle))
    : ingredients.some((needle) => haystackHas(needle))
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

  const toggleTag = (id: string) => {
    setTagIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))
  }

  const addIngredient = () => {
    const value = ingredientInput.trim()
    if (!value) return
    setIngredients((current) => (current.includes(value) ? current : [...current, value]))
    setIngredientInput('')
  }

  const removeIngredient = (value: string) => {
    setIngredients((current) => current.filter((item) => item !== value))
  }

  const clearCategory = () => setCategoryId('')
  const clearTags = () => setTagIds([])
  const clearTimeFilters = () => {
    setMaxPrepTime(undefined)
    setMaxCookTime(undefined)
    setCustomPrep('')
    setCustomCook('')
  }
  const clearIngredients = () => setIngredients([])
  const clearAllFilters = () => {
    clearCategory()
    clearTags()
    clearTimeFilters()
    clearIngredients()
  }

  const hasAnyFilter = Boolean(categoryId) || tagIds.length > 0 || maxPrepTime !== undefined || maxCookTime !== undefined || ingredients.length > 0

  const roll = useCallback(async () => {
    if (!activeProfile) return

    setRolling(true)
    setError('')
    setSearchedNoResults(false)

    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      const candidates = await client.getAllRecipes({
        categories: categoryId ? [categoryId] : undefined,
        tags: tagIds.length > 0 ? tagIds : undefined,
        maxPrepTime,
        maxCookTime,
      })

      let pool: RouletteResultRecipe[] = candidates

      if (ingredients.length > 0) {
        const details = await Promise.allSettled(candidates.map((recipe) => client.getRecipe(recipe.slug || recipe.id)))
        pool = candidates.filter((_recipe, index) => {
          const detailResult = details[index]
          if (detailResult.status !== 'fulfilled') return false
          return matchesIngredients(detailResult.value, ingredients, ingredientMode)
        })
      }

      if (pool.length === 0) {
        setResult(null)
        setSearchedNoResults(true)
        return
      }

      // Avoid immediately repeating a very recent result when other options exist.
      const notRecentlyShown = pool.filter((recipe) => !recentResultIds.current.includes(recipe.id))
      const choicePool = notRecentlyShown.length > 0 ? notRecentlyShown : pool
      const chosen = choicePool[Math.floor(Math.random() * choicePool.length)]

      recentResultIds.current = [chosen.id, ...recentResultIds.current].slice(0, 5)
      setResult(chosen)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to roll for a recipe.')
    } finally {
      setRolling(false)
    }
  }, [activeProfile, categoryId, tagIds, maxPrepTime, maxCookTime, ingredients, ingredientMode])

  const timePresets = [10, 20, 30, 45, 60]

  return (
    <main className="app-shell detail-shell roulette-shell">
      <AppHeader activeProfile={activeProfile} />

      <div className="detail-toolbar">
        <Link className="text-link" to="/">← Home</Link>
      </div>

      {!activeProfile ? (
        <section className="page-empty compact-empty">
          <p>No active Mealie account is connected.</p>
          <Link className="primary-button" to="/setup">Connect to Mealie</Link>
        </section>
      ) : (
        <>
          <section className="page-intro">
            <p className="eyebrow">A Mealie Connect original</p>
            <h1>🎲 Dinner Roulette</h1>
            <p className="intro-copy">Don&rsquo;t know what to cook? Roll completely at random, or narrow it down below. Every filter is optional.</p>
          </section>

          <section className="roulette-filters">
            <div className="roulette-filter-group">
              <h4>Category</h4>
              <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </div>

            <div className="roulette-filter-group">
              <h4>Prep time</h4>
              <div className="chip-list">
                <button type="button" className={maxPrepTime === undefined ? 'chip active' : 'chip'} onClick={() => { setMaxPrepTime(undefined); setCustomPrep('') }}>Any</button>
                {timePresets.map((minutes) => (
                  <button key={minutes} type="button" className={maxPrepTime === minutes ? 'chip active' : 'chip'} onClick={() => { setMaxPrepTime(minutes); setCustomPrep('') }}>{minutes} min</button>
                ))}
                <input
                  type="number"
                  min={1}
                  className="roulette-custom-time"
                  placeholder="Custom"
                  value={customPrep}
                  onChange={(event) => {
                    setCustomPrep(event.target.value)
                    const parsed = Number.parseInt(event.target.value, 10)
                    setMaxPrepTime(Number.isNaN(parsed) ? undefined : parsed)
                  }}
                  aria-label="Custom maximum prep time in minutes"
                />
              </div>
            </div>

            <div className="roulette-filter-group">
              <h4>Cook time</h4>
              <div className="chip-list">
                <button type="button" className={maxCookTime === undefined ? 'chip active' : 'chip'} onClick={() => { setMaxCookTime(undefined); setCustomCook('') }}>Any</button>
                {timePresets.map((minutes) => (
                  <button key={minutes} type="button" className={maxCookTime === minutes ? 'chip active' : 'chip'} onClick={() => { setMaxCookTime(minutes); setCustomCook('') }}>{minutes} min</button>
                ))}
                <input
                  type="number"
                  min={1}
                  className="roulette-custom-time"
                  placeholder="Custom"
                  value={customCook}
                  onChange={(event) => {
                    setCustomCook(event.target.value)
                    const parsed = Number.parseInt(event.target.value, 10)
                    setMaxCookTime(Number.isNaN(parsed) ? undefined : parsed)
                  }}
                  aria-label="Custom maximum cook time in minutes"
                />
              </div>
            </div>

            <div className="roulette-filter-group">
              <h4>Tags</h4>
              <div className="chip-list">
                {tags.length === 0 ? <p className="empty-copy">No tags found on your Mealie server.</p> : null}
                {tags.map((tag) => (
                  <button key={tag.id} type="button" className={tagIds.includes(tag.id) ? 'chip active' : 'chip'} onClick={() => toggleTag(tag.id)}>{tag.name}</button>
                ))}
              </div>
            </div>

            <div className="roulette-filter-group">
              <h4>Ingredients on hand</h4>
              <div className="roulette-ingredient-input">
                <input
                  type="text"
                  value={ingredientInput}
                  onChange={(event) => setIngredientInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addIngredient()
                    }
                  }}
                  placeholder="Chicken, rice, garlic…"
                  aria-label="Add an ingredient you have on hand"
                />
                <button type="button" className="secondary-button small-button" onClick={addIngredient}>Add</button>
              </div>
              {ingredients.length > 0 ? (
                <div className="chip-list">
                  {ingredients.map((ingredient) => (
                    <button key={ingredient} type="button" className="chip active" onClick={() => removeIngredient(ingredient)} aria-label={`Remove ${ingredient}`}>
                      {ingredient} ✕
                    </button>
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

            {hasAnyFilter ? (
              <button type="button" className="text-button" onClick={clearAllFilters}>Clear all filters</button>
            ) : null}
          </section>

          {error ? <p className="error-text">{error}</p> : null}

          <section className="roulette-roll-section">
            <button
              type="button"
              className="primary-button roulette-roll-button"
              onClick={() => void roll()}
              disabled={rolling}
            >
              <span className={rolling ? 'roulette-dice rolling' : 'roulette-dice'} aria-hidden="true">🎲</span>
              {rolling ? 'Rolling…' : 'ROLL'}
            </button>
          </section>

          {searchedNoResults ? (
            <section className="page-empty compact-empty roulette-no-results">
              <p><strong>No recipes match those filters.</strong></p>
              <div className="roulette-current-filters">
                {categoryId ? <span className="chip active">{categories.find((category) => category.id === categoryId)?.name ?? 'Category'}</span> : null}
                {tagIds.map((id) => <span key={id} className="chip active">{tags.find((tag) => tag.id === id)?.name ?? 'Tag'}</span>)}
                {maxPrepTime !== undefined ? <span className="chip active">Prep ≤ {maxPrepTime} min</span> : null}
                {maxCookTime !== undefined ? <span className="chip active">Cook ≤ {maxCookTime} min</span> : null}
                {ingredients.map((ingredient) => <span key={ingredient} className="chip active">{ingredient}</span>)}
              </div>
              <p>Try:</p>
              <div className="roulette-clear-buttons">
                {ingredients.length > 0 ? <button type="button" className="secondary-button small-button" onClick={clearIngredients}>Clear ingredients</button> : null}
                {(maxPrepTime !== undefined || maxCookTime !== undefined) ? <button type="button" className="secondary-button small-button" onClick={clearTimeFilters}>Clear time filters</button> : null}
                {tagIds.length > 0 ? <button type="button" className="secondary-button small-button" onClick={clearTags}>Clear tags</button> : null}
                {categoryId ? <button type="button" className="secondary-button small-button" onClick={clearCategory}>Clear category</button> : null}
                <button type="button" className="secondary-button small-button" onClick={clearAllFilters}>Clear all filters</button>
              </div>
            </section>
          ) : null}

          {result ? (
            <>
              <section className="detail-hero random-hero">
                <RecipeThumbnail activeProfile={activeProfile} recipe={result} className="detail-image" />
                <div>
                  <p className="eyebrow">🎲 Tonight&rsquo;s recipe</p>
                  <h2>{result.name}</h2>
                  <p>{result.description ?? 'A delicious recipe waiting to be cooked.'}</p>
                  <div className="meta-row detail-meta">
                    {(result.categories ?? []).map((category) => <span key={category.id}>{category.name}</span>)}
                    {(result.tags ?? []).map((tag) => <span key={tag.id}>{tag.name}</span>)}
                    {result.prepTime ? <span>Prep: {result.prepTime} min</span> : null}
                    {result.cookTime ? <span>Cook: {result.cookTime} min</span> : null}
                  </div>
                </div>
              </section>

              <section className="random-actions">
                <div>
                  <Link className="primary-button" to={`/cook/${result.slug || result.id}`}>Cook Now</Link>
                  <button type="button" className="secondary-button" onClick={() => setShowMealPlanModal(true)}>Add to Meal Plan</button>
                  <button type="button" className="secondary-button" onClick={() => setShowShoppingModal(true)}>Add Ingredients to Shopping List</button>
                  <Link className="secondary-button" to={`/recipes/${result.slug || result.id}`}>View Recipe</Link>
                  <button type="button" className="secondary-button" onClick={() => void roll()} disabled={rolling}>Roll Again</button>
                </div>
              </section>
            </>
          ) : null}

          {showMealPlanModal && result ? (
            <AddToMealPlanModal
              activeProfile={activeProfile}
              recipe={result}
              onClose={() => setShowMealPlanModal(false)}
            />
          ) : null}

          {showShoppingModal && result ? (
            <AddIngredientsToShoppingListModal
              activeProfile={activeProfile}
              recipeId={result.id}
              recipeName={result.name}
              onClose={() => setShowShoppingModal(false)}
            />
          ) : null}
        </>
      )}
    </main>
  )
}

/** Adds a recipe (by id/name) to a chosen date and meal type via the real
 * Mealie meal-plan endpoint. Shared by Dinner Roulette and the meal planner. */
function AddToMealPlanModal({
  activeProfile,
  recipe,
  onClose,
}: {
  activeProfile: MealieProfile
  recipe: MealieRecipeSummary
  onClose: () => void
}) {
  useModalEscapeToClose(onClose)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [mealType, setMealType] = useState<PlannableMealType>('dinner')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
      await client.createMealPlanEntry({
        date,
        entryType: mealType,
        title: recipe.name,
        recipeId: recipe.id,
      })
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
            <p className="success-text">✓ Added {recipe.name} to {MEAL_TYPE_LABELS[mealType]} on {date}</p>
            <div className="modal-actions">
              <Link className="secondary-button" to="/meal-plan">View Meal Plan</Link>
              <button type="button" className="primary-button" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h3>Add “{recipe.name}” to your meal plan</h3>
            <label>
              Date
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label>
              Meal
              <select value={mealType} onChange={(event) => setMealType(event.target.value as PlannableMealType)}>
                {PLANNABLE_MEAL_TYPES.map((type) => (
                  <option key={type} value={type}>{MEAL_TYPE_LABELS[type]}</option>
                ))}
              </select>
            </label>
            {error ? <p className="error-text">{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="text-button" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="button" className="primary-button" onClick={() => void submit()} disabled={submitting}>
                {submitting ? 'Adding…' : 'Add to Meal Plan'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Adds every ingredient from a recipe to an existing or newly created
 * shopping list, using the real Mealie shopping-list API. */
function AddIngredientsToShoppingListModal({
  activeProfile,
  recipeId,
  recipeName,
  onClose,
}: {
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
    client
      .getShoppingLists()
      .then((nextLists) => {
        setLists(nextLists)
        setSelectedListId(nextLists[0]?.id ?? '')
        if (nextLists.length === 0) setMode('create')
      })
      .catch((err: Error) => setListError(err.message))
      .finally(() => setLoadingLists(false))
  }, [activeProfile])

  const submit = async () => {
    setError('')
    setSubmitting(true)
    try {
      const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })

      let targetListId = selectedListId
      let targetListName = lists.find((list) => list.id === selectedListId)?.name ?? ''
      const initialItemCount = mode === 'create'
        ? 0
        : lists.find((list) => list.id === selectedListId)?.items?.length ?? 0

      if (mode === 'create') {
        if (!newListName.trim()) {
          throw new Error('Enter a name for the new shopping list.')
        }
        const created = await client.createShoppingList(newListName.trim())
        targetListId = created.id
        targetListName = created.name
      } else if (!targetListId) {
        throw new Error('Choose a shopping list.')
      }

      const updated = await client.addRecipeIngredientsToShoppingList(targetListId, recipeId)
      setResult({
        listId: targetListId,
        listName: targetListName,
        added: Math.max(0, (updated.items?.length ?? 0) - initialItemCount),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add ingredients. Check your connection to Mealie and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add ingredients to shopping list">
      <div className="modal-panel">
        {result ? (
          <>
            <p className="success-text">✓ Added {result.added} ingredient{result.added === 1 ? '' : 's'} to {result.listName}</p>
            <div className="modal-actions">
              <Link className="secondary-button" to={`/shopping/${result.listId}`}>View Shopping List</Link>
              <button type="button" className="primary-button" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h3>Add ingredients from “{recipeName}”</h3>
            <p className="intro-copy">Add ingredients to&hellip;</p>

            {loadingLists ? <p>Loading your shopping lists…</p> : null}
            {listError ? <p className="error-text">{listError}</p> : null}

            {!loadingLists ? (
              <div className="shopping-target-picker">
                {lists.length > 0 ? (
                  <label>
                    <input type="radio" name="shopping-target-mode" checked={mode === 'select'} onChange={() => setMode('select')} />
                    Existing shopping list
                  </label>
                ) : null}
                {mode === 'select' && lists.length > 0 ? (
                  <select value={selectedListId} onChange={(event) => setSelectedListId(event.target.value)}>
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>{list.name}</option>
                    ))}
                  </select>
                ) : null}

                <label>
                  <input type="radio" name="shopping-target-mode" checked={mode === 'create'} onChange={() => setMode('create')} />
                  + Create new shopping list
                </label>
                {mode === 'create' ? (
                  <input
                    type="text"
                    value={newListName}
                    onChange={(event) => setNewListName(event.target.value)}
                    placeholder="Shopping list name"
                    aria-label="New shopping list name"
                  />
                ) : null}
              </div>
            ) : null}

            {error ? <p className="error-text">{error}</p> : null}

            <div className="modal-actions">
              <button type="button" className="text-button" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="button" className="primary-button" onClick={() => void submit()} disabled={submitting || loadingLists}>
                {submitting ? 'Adding…' : mode === 'create' ? 'Create & Add Ingredients' : 'Add Ingredients'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default App
