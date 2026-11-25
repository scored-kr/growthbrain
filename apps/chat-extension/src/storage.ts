import { emptyMemory, type MemoryState } from './memory.ts'

// Both objects stay in the extension origin. The browser can persist a nonextractable
// CryptoKey via structured clone. This device key is never sent to the relay.
const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const open = indexedDB.open('growth-brain-local', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('records')
  open.onsuccess = () => resolve(open.result)
  open.onerror = () => reject(open.error)
})

function read<T>(db: IDBDatabase, name: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').get(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

type Sealed = { iv: Uint8Array<ArrayBuffer>, bytes: ArrayBuffer }

export async function withMemory<T>(edit: boolean, run: (state: MemoryState) => T, beforeWrite?: () => Promise<void>): Promise<T> {
  const db = await database()
  try {
    const [savedKey, sealed] = await Promise.all([read<CryptoKey>(db, 'key'), read<Sealed>(db, 'snapshot')])
    if (Boolean(savedKey) !== Boolean(sealed)) throw new Error('Incomplete local snapshot')
    const key = savedKey ?? await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt','decrypt'])
    const state: MemoryState = sealed
      ? JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM', iv:sealed.iv}, key, sealed.bytes)))
      : emptyMemory()
    const before = edit ? JSON.stringify(state) : undefined
    const result = run(state)
    if (edit) {
      const json = JSON.stringify(state)
      if (json === before) return result
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const bytes = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(json))
      if (beforeWrite) await beforeWrite()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error || new Error('Snapshot write aborted'))
        const store = tx.objectStore('records')
        if (!savedKey) store.add(key, 'key')
        store.put({iv, bytes}, 'snapshot')
      })
    }
    return result
  } finally {
    db.close()
  }
}
