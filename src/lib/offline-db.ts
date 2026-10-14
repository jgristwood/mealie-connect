/**
 * A small key-value store on IndexedDB, used to keep Mealie data on the
 * device for offline use. Falls back to memory where IndexedDB is missing
 * or blocked (private browsing, tests), so callers never need to care.
 */

const DB_NAME = 'mealie-connect-offline'
const STORE_NAME = 'kv'

const memory = new Map<string, unknown>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    try {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE_NAME) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    if (!db) { resolve(undefined); return }
    const transaction = db.transaction(STORE_NAME, mode)
    const request = action(transaction.objectStore(STORE_NAME))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error ?? request.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Saving offline data was cancelled.'))
  }))
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  if (!db) return memory.get(key) as T | undefined
  return await run<T>('readonly', (store) => store.get(key) as IDBRequest<T>)
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  if (!db) { memory.set(key, value); return }
  await run('readwrite', (store) => store.put(value, key))
}

export async function kvDelete(key: string): Promise<void> {
  const db = await openDb()
  if (!db) { memory.delete(key); return }
  await run('readwrite', (store) => store.delete(key))
}

/** Deletes every key that starts with `prefix`. */
export async function kvDeletePrefix(prefix: string): Promise<void> {
  const db = await openDb()
  if (!db) {
    for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key)
    return
  }
  await run('readwrite', (store) => store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)))
}
