import type { AuthMethod, MealieProfile } from '../../types/mealie'
import { storage } from '../../lib/storage'
import { credentialStore } from './credential-store'

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

    const profileId = crypto.randomUUID()
    const profile: MealieProfile = {
      id: profileId,
      name: credentials.username ?? 'Mealie Account',
      server,
      authMethod: credentials.method,
      username: credentials.username,
      displayName: credentials.username ?? 'API token user',
    }

    await credentialStore.setProfileToken(profileId, token)
    const profiles = await this.listProfiles()
    const next = [...profiles, profile]
    this.saveProfiles(next)
    this.setActiveProfile(profileId)
    return { ...profile, token }
  },

  signOut(): void {
    storage.remove(ACTIVE_PROFILE_KEY)
  },
}

function createClient({ server, token }: { server: string; token?: string }) {
  return {
    async loginWithPassword(username: string, password: string): Promise<string> {
      const form = new URLSearchParams({ username, password })
      const response = await fetch(`${server}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })

      if (!response.ok) {
        throw new Error('Your Mealie login is no longer valid. Please sign in again.')
      }

      const payload = (await response.json()) as { access_token?: string; token?: string }
      const nextToken = payload.access_token ?? payload.token
      if (!nextToken) {
        throw new Error('The Mealie authentication response did not include a token.')
      }

      return nextToken
    },
    async getCurrentUser(): Promise<{ username?: string }> {
      const response = await fetch(`${server}/api/users/self`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error('Unable to load the current Mealie user profile.')
      }

      return (await response.json()) as { username?: string }
    },
  }
}
