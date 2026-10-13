import type { AuthMethod, MealieProfile } from '../../types/mealie'
import { storage } from '../../lib/storage'
import { credentialStore } from './credential-store'
import { MealieClient } from '../mealie/mealie-client'

const PROFILE_KEY = 'mealie-connect-profiles'
const ACTIVE_PROFILE_KEY = 'mealie-connect-active-profile'

export interface AuthCredentials {
  server: string
  username?: string
  password?: string
  token?: string
  method: AuthMethod
}

export const authService = {
  async listProfiles(): Promise<MealieProfile[]> {
    const storedProfiles = storage.get<Array<MealieProfile & { token?: string }>>(PROFILE_KEY) ?? []
    const hydratedProfiles = await Promise.all(
      storedProfiles.map(async (profile) => {
        const storedToken = await credentialStore.getProfileToken(profile.id)
        if (!storedToken && profile.token) {
          await credentialStore.setProfileToken(profile.id, profile.token)
        }

        return {
          ...profile,
          token: storedToken ?? profile.token,
        }
      }),
    )

    if (storedProfiles.some((profile) => profile.token)) {
      this.saveProfiles(hydratedProfiles)
    }

    return hydratedProfiles
  },

  async getActiveProfile(): Promise<MealieProfile | null> {
    const id = storage.get<string>(ACTIVE_PROFILE_KEY)
    if (!id) {
      return null
    }

    const profiles = await this.listProfiles()
    return profiles.find((profile) => profile.id === id) ?? null
  },

  saveProfiles(profiles: MealieProfile[]): void {
    const serializedProfiles = profiles.map(({ token: _token, ...profile }) => profile)
    storage.set(PROFILE_KEY, serializedProfiles)
  },

  setActiveProfile(profileId: string): void {
    storage.set(ACTIVE_PROFILE_KEY, profileId)
  },

  async signIn(credentials: AuthCredentials): Promise<MealieProfile> {
    const server = credentials.server.trim().replace(/\/+$/, '')
    const client = createClient({ server, token: credentials.token })

    let token = credentials.token

    if (credentials.method === 'password') {
      if (!credentials.username || !credentials.password) {
        throw new Error('A username and password are required to sign in.')
      }

      token = await client.loginWithPassword(credentials.username, credentials.password)
    }

    if (!token) {
      throw new Error('A valid Mealie token could not be established.')
    }

    const mealie = new MealieClient({ baseUrl: server, token })

    if (credentials.method === 'password') {
      // Session tokens from a password login expire (48h by default). Swap
      // for a long-lived API token when the server allows it; otherwise keep
      // the session token and the user can sign in again when it expires.
      try {
        const deviceLabel = `Mealie Connect (${new Date().toISOString().slice(0, 10)})`
        token = await mealie.createApiToken(deviceLabel)
      } catch {
        // Older servers or restricted accounts: fall back to the session token.
      }
    }

    let username = credentials.username
    let displayName = credentials.username
    try {
      const user = await new MealieClient({ baseUrl: server, token }).getCurrentUser()
      username = user.username ?? username
      displayName = user.fullName ?? user.full_name ?? user.username ?? displayName
    } catch {
      // Profile details are cosmetic; don't fail sign-in over them.
    }

    const profiles = await this.listProfiles()
    // Signing in again to the same account refreshes its token instead of
    // creating a duplicate profile.
    const existing = username
      ? profiles.find((profile) => profile.server === server && profile.username?.toLowerCase() === username.toLowerCase())
      : undefined
    const profileId = existing?.id ?? crypto.randomUUID()
    const profile: MealieProfile = {
      id: profileId,
      name: username ?? 'Mealie Account',
      server,
      authMethod: credentials.method,
      username,
      displayName: displayName ?? 'API token user',
    }

    await credentialStore.setProfileToken(profileId, token)
    const next = existing
      ? profiles.map((candidate) => (candidate.id === profileId ? profile : candidate))
      : [...profiles, profile]
    this.saveProfiles(next)
    this.setActiveProfile(profileId)
    return { ...profile, token }
  },

  /** Forgets a saved account on this device, including its stored token. */
  async removeProfile(profileId: string): Promise<void> {
    const profiles = await this.listProfiles()
    this.saveProfiles(profiles.filter((profile) => profile.id !== profileId))
    await credentialStore.removeProfileToken(profileId)
    if (storage.get<string>(ACTIVE_PROFILE_KEY) === profileId) {
      storage.remove(ACTIVE_PROFILE_KEY)
    }
  },

  signOut(): void {
    storage.remove(ACTIVE_PROFILE_KEY)
  },
}

function createClient({ server }: { server: string; token?: string }) {
  return {
    async loginWithPassword(username: string, password: string): Promise<string> {
      const form = new URLSearchParams({ username, password })
      const response = await fetch(`${server}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Mealie did not accept that username and password.')
        }
        throw new Error(`Mealie sign-in failed (server returned ${response.status}).`)
      }

      const payload = (await response.json()) as { access_token?: string; token?: string }
      const nextToken = payload.access_token ?? payload.token
      if (!nextToken) {
        throw new Error('The Mealie authentication response did not include a token.')
      }

      return nextToken
    },
  }
}
