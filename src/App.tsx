import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { authService } from './services/auth/auth-service'
import { MealieClient } from './services/mealie/mealie-client'
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
} from './types/mealie'
import './App.css'

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
  return (
    <header className="app-header">
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
      {activeProfile ? (
        <nav className="main-nav" aria-label="Primary navigation">
          {showHomeButton ? <Link to="/">Home</Link> : null}
          <Link to="/recipes">Recipes</Link>
          <Link to="/meal-plan">Meal plan</Link>
          <Link to="/shopping">Shopping list</Link>
        </nav>
      ) : null}
      <Link className="header-import-button" to="/import" aria-label="Import a recipe" title="Import a recipe">+</Link>
      {!activeProfile ? <Link className="text-link header-connect-link" to="/setup">Connect</Link> : null}
    </header>
  )
}

function ScrollToTop() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [pathname])

  return null
}

function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: React.ReactNode }) {
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
  const [error, setError] = useState('')

  const loadProfiles = () => {
    const nextProfiles = authService.listProfiles()
    setProfiles(nextProfiles)
    setActiveProfile(authService.getActiveProfile())
  }

  useEffect(() => {
    loadProfiles()
  }, [])

  useEffect(() => {
    if (!activeProfile) {
      setRecipes([])
      setCategories([])
      setTags([])
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
            perPage: 50,
          }),
          client.getCategories(),
          client.getTags(),
        ])

        // Extract results, using empty arrays as fallback for failures
        const nextRecipes = results[0]?.status === 'fulfilled' ? results[0].value : []
        const nextCategories = results[1]?.status === 'fulfilled' ? results[1].value : []
        const nextTags = results[2]?.status === 'fulfilled' ? results[2].value : []

        setRecipes(nextRecipes)
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

    const nextProfiles = authService.listProfiles()
    setProfiles(nextProfiles)
    setActiveProfile(profile)
  }

  const signOut = () => {
    authService.signOut()
    setActiveProfile(null)
    loadProfiles()
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
              profiles={profiles}
              recipes={recipes}
              loading={loading}
              error={error}
              onSelectProfile={setActiveProfile}
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
          path="/meal-plan/:id"
          element={<MealPlanDetailPage activeProfile={activeProfile} />}
        />
        <Route
          path="/random-recipe"
          element={<RandomRecipePage activeProfile={activeProfile} />}
        />
      </Routes>
    </BrowserRouter>
  )
}

function HomePage({
  activeProfile,
  profiles,
  recipes,
  loading,
  error,
  onSelectProfile,
  onSignOut,
}: {
  activeProfile: MealieProfile | null
  profiles: MealieProfile[]
  recipes: MealieRecipeSummary[]
  loading: boolean
  error: string
  onSelectProfile: (profile: MealieProfile) => void
  onSignOut: () => void
}) {
  const overview = useMemo(() => recipes.slice(0, 4), [recipes])
  return (
    <main className="app-shell">
      <AppHeader activeProfile={activeProfile} showHomeButton={false} />

      <section className="home-intro">
        <p className="eyebrow">Your cooking space</p>
        <h1>{activeProfile ? 'What are you cooking this week?' : 'A calmer way to cook from your Mealie library.'}</h1>
        <p className="intro-copy">
          {activeProfile ? 'Find something familiar, make a plan, or let dinner surprise you.' : 'Connect your self-hosted Mealie server and bring your recipes into focus.'}
        </p>
        {!activeProfile ? <Link className="primary-button" to="/setup">Connect to Mealie</Link> : null}
      </section>

      {activeProfile ? (
        <>
          <section className="home-feature">
            <div className="feature-copy">
              <p className="eyebrow">Start with a little inspiration</p>
              <h2>Discover something worth making.</h2>
              <p>Take the decision out of dinner with a recipe chosen from your own collection.</p>
              <Link className="primary-button" to="/random-recipe">Discover a recipe</Link>
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
              {overview.map((recipe, index) => (
                <Link key={recipe.id} className={index === 0 ? 'recipe-card recipe-card-featured' : 'recipe-card'} to={`/recipes/${recipe.slug || recipe.id}`}>
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

      {activeProfile && profiles.length > 0 ? (
        <details className="account-details">
          <summary>Account and connection</summary>
          <div className="account-details-body">
            <div><strong>{activeProfile.displayName ?? activeProfile.username ?? 'Mealie user'}</strong><span>{activeProfile.server}</span></div>
            <div className="profile-list">{profiles.map((profile) => <button key={profile.id} type="button" className={`profile-item ${activeProfile.id === profile.id ? 'active' : ''}`} onClick={() => onSelectProfile(profile)}>{profile.displayName ?? profile.username ?? profile.name}</button>)}</div>
            <button type="button" className="text-button danger-text" onClick={onSignOut}>Sign out</button>
          </div>
        </details>
      ) : null}
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

      window.location.href = '/'
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
      window.location.href = '/'
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
  error: string
}) {
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
            <Link className="secondary-button page-intro-action" to="/random-recipe">Random recipe</Link>
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

  return imageUrl ? (
    <img className={className} src={imageUrl} alt="" />
  ) : (
    <div className={`${className} placeholder`} aria-hidden="true"><span>No image</span></div>
  )
}

function RecipeDetailPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { slug } = useParams()
  const [recipe, setRecipe] = useState<MealieRecipeDetail | null>(null)
  const [imageUrl, setImageUrl] = useState('')
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
          <section className={`detail-hero${imageUrl ? ' with-image' : ''}`}>
            {imageUrl ? (
              <img className="detail-image" src={imageUrl} alt={recipe.name} />
            ) : null}
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
            <SectionHeading eyebrow={`${(list.items ?? []).length} to gather`} title="Items" />
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

function MealPlanPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [plans, setPlans] = useState<MealieWeekPlan[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0])
  const [entryType, setEntryType] = useState('dinner')
  const [entryTitle, setEntryTitle] = useState('')
  const [entryText, setEntryText] = useState('')

  useEffect(() => {
    if (!activeProfile) {
      setPlans([])
      return
    }

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setLoading(true)
    setError('')

    const today = new Date()
    const startDate = today.toISOString().split('T')[0]
    const endDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    client
      .getMealPlans(startDate, endDate)
      .then((nextPlans) => setPlans(nextPlans))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [activeProfile])

  const createEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeProfile || !entryDate) return

    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setError('')

    try {
      const entry = await client.createMealPlanEntry({
        date: entryDate,
        entryType,
        title: entryTitle.trim() || undefined,
        text: entryText.trim() || undefined,
      })
      setPlans((current) => [entry, ...current])
      setEntryTitle('')
      setEntryText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create meal plan entry.')
    }
  }

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

          {error ? <p className="error-text">{error}</p> : null}
          {loading ? <p>Loading meal plans…</p> : null}

          <section className="task-form">
            <form onSubmit={createEntry} className="form-stack">
              <h3>Plan a meal</h3>
              <div className="meal-form-grid">
                <label>
                  Date
                  <input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
                </label>
                <label>
                  Meal
                  <select value={entryType} onChange={(event) => setEntryType(event.target.value)}>
                    <option value="breakfast">Breakfast</option>
                    <option value="lunch">Lunch</option>
                    <option value="dinner">Dinner</option>
                    <option value="side">Side</option>
                  </select>
                </label>
                <label className="meal-title-field">
                  Recipe or meal title
                  <input value={entryTitle} onChange={(event) => setEntryTitle(event.target.value)} placeholder="What are you planning?" />
                </label>
              </div>
              <label>
                Notes
                <textarea value={entryText} onChange={(event) => setEntryText(event.target.value)} rows={2} placeholder="Optional notes" />
              </label>
              <button type="submit" className="primary-button">Add to meal plan</button>
            </form>
          </section>

          {plans.length === 0 && !loading ? (
            <section className="page-empty compact-empty">
              <p>No meal plans for this week. Start planning your meals!</p>
            </section>
          ) : (
            <section className="list-stack">
              {plans.map((plan) => (
                <article key={plan.id} className="list-row">
                  <div className="recipe-card-body">
                    <div className="recipe-card-header">
                      <div>
                        <h3>{plan.recipe?.name ?? plan.title ?? 'Meal plan entry'}</h3>
                        <p className="meal-plan-meta">
                          <span>{plan.date ?? 'Date not specified'}</span>
                          <span>{plan.entryType ?? 'Meal'}</span>
                        </p>
                      </div>
                      <Link className="secondary-button small-button" to={`/meal-plan/${plan.id}`}>
                        View
                      </Link>
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

function MealPlanDetailPage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const [plan, setPlan] = useState<MealieWeekPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!activeProfile || !id) {
      setPlan(null)
      return
    }

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setLoading(true)
    setError('')

    client
      .getMealPlan(id)
      .then((nextPlan) => setPlan(nextPlan))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [activeProfile, id])

  const deleteEntry = async () => {
    if (!activeProfile || !id) return

    const client = new MealieClient({ baseUrl: activeProfile.server, token: activeProfile.token })
    setError('')
    try {
      await client.deleteMealPlanEntry(id)
      navigate('/meal-plan')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete meal plan entry.')
    }
  }

  return (
    <main className="app-shell detail-shell">
      <AppHeader activeProfile={activeProfile} />

      <div className="detail-toolbar">
        <Link className="text-link" to="/meal-plan">← Back to plans</Link>
      </div>

      {loading ? <p>Loading meal plan…</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {!plan && !loading && !error ? <p>No plan found.</p> : null}

      {plan ? (
        <>
          <section className="page-intro detail-page-intro">
            <p className="eyebrow">Meal plan entry</p>
            <h1>{plan.recipe?.name ?? plan.title ?? 'Untitled meal'}</h1>
            <p className="intro-copy">{plan.date ?? 'Date not specified'} · {plan.entryType ?? 'Meal'}</p>
            <button type="button" className="text-button danger-text" onClick={deleteEntry}>Delete entry</button>
          </section>

          <section className="content-section">
            <SectionHeading eyebrow="A note for later" title="Details" />
            <p>{plan.text ?? 'No notes for this meal.'}</p>
          </section>
        </>
      ) : null}
    </main>
  )
}

function RandomRecipePage({ activeProfile }: { activeProfile: MealieProfile | null }) {
  const [recipe, setRecipe] = useState<MealieRecipeSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const getRandomRecipe = useCallback(async () => {
    if (!activeProfile) return

    const client = new MealieClient({
      baseUrl: activeProfile.server,
      token: activeProfile.token,
    })

    setLoading(true)
    setError('')

    try {
      const recipes = await client.getRecipes({ perPage: 100 })
      if (recipes.length > 0) {
        const randomIndex = Math.floor(Math.random() * recipes.length)
        setRecipe(recipes[randomIndex])
      } else {
        setError('No recipes available in your library.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recipes.')
    } finally {
      setLoading(false)
    }
  }, [activeProfile])

  useEffect(() => {
    void getRandomRecipe()
  }, [getRandomRecipe])

  return (
    <main className="app-shell detail-shell random-shell">
      <AppHeader activeProfile={activeProfile} />

      <div className="detail-toolbar">
        <Link className="text-link" to="/">← Home</Link>
      </div>

      {!activeProfile ? (
        <section className="page-empty compact-empty">
          <p>No active Mealie account is connected.</p>
          <Link className="primary-button" to="/setup">
            Connect to Mealie
          </Link>
        </section>
      ) : (
        <>
          {error ? <p className="error-text">{error}</p> : null}

          {loading ? (
            <section className="page-empty compact-empty">
              <p>Finding a recipe for you…</p>
            </section>
          ) : recipe ? (
            <>
              <section className="detail-hero random-hero">
                <RecipeThumbnail activeProfile={activeProfile} recipe={recipe} className="detail-image" />
                <div>
                  <p className="eyebrow">What should you make?</p>
                  <h2>{recipe.name}</h2>
                  <p>{recipe.description ?? 'A delicious recipe waiting to be cooked.'}</p>
                  <div className="meta-row detail-meta">
                    <span>{recipe.categories?.[0]?.name ?? 'Uncategorized'}</span>
                    {recipe.totalTime ? <span>{recipe.totalTime} min</span> : null}
                    {recipe.servings ? <span>{recipe.servings} servings</span> : null}
                  </div>
                </div>
              </section>

              <section className="random-actions">
                <div>
                  <Link
                    className="primary-button"
                    to={`/cook/${recipe.slug || recipe.id}`}
                  >
                    Cook this recipe
                  </Link>
                  <Link
                    className="secondary-button"
                    to={`/recipes/${recipe.slug || recipe.id}`}
                  >
                    View full recipe
                  </Link>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => getRandomRecipe()}
                    disabled={loading}
                  >
                    Another recipe
                  </button>
                </div>
              </section>
            </>
          ) : (
            <section className="page-empty compact-empty">
              <p>No recipe selected yet.</p>
              <button
                type="button"
                className="primary-button"
                onClick={() => getRandomRecipe()}
                disabled={loading}
              >
                Get Random Recipe
              </button>
            </section>
          )}
        </>
      )}
    </main>
  )
}

export default App
