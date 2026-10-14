/** App-wide offline and sync state, readable from React with useSyncStatus. */
import { useSyncExternalStore } from 'react'

export interface SyncStatus {
  /** The last request could not reach the Mealie server. */
  offline: boolean
  /** Changes made offline that have not reached Mealie yet. */
  pending: number
  syncing: boolean
  /** ISO time of the last completed sync of offline data. */
  lastSyncedAt?: string
  /** Changes Mealie rejected while syncing (e.g. the item was deleted elsewhere). */
  failed: number
  /** Increases whenever synced data changes, so pages can reload. */
  revision: number
}

let status: SyncStatus = { offline: typeof navigator !== 'undefined' && navigator.onLine === false, pending: 0, syncing: false, failed: 0, revision: 0 }
const listeners = new Set<() => void>()

export function getSyncStatus(): SyncStatus {
  return status
}

export function updateSyncStatus(changes: Partial<SyncStatus>): void {
  const next = { ...status, ...changes }
  if ((Object.keys(next) as Array<keyof SyncStatus>).every((key) => next[key] === status[key])) return
  status = next
  for (const listener of listeners) listener()
}

/** Tells open pages that synced data changed and they should reload. */
export function bumpSyncRevision(): void {
  updateSyncStatus({ revision: status.revision + 1 })
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus)
}
