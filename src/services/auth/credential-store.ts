import { SecureStorage } from '@aparajita/capacitor-secure-storage'

const TOKEN_KEY_PREFIX = 'mealie-connect-profile-token:'

function tokenKey(profileId: string): string {
  return `${TOKEN_KEY_PREFIX}${profileId}`
}

export const credentialStore = {
  async getProfileToken(profileId: string): Promise<string | null> {
    const value = await SecureStorage.get(tokenKey(profileId))
    return typeof value === 'string' && value.length > 0 ? value : null
  },

  async setProfileToken(profileId: string, token: string): Promise<void> {
    await SecureStorage.set(tokenKey(profileId), token)
  },

  async removeProfileToken(profileId: string): Promise<void> {
    await SecureStorage.remove(tokenKey(profileId))
  },
}
