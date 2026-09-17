export type CloudStorageStatus = 'checking' | 'local' | 'saving' | 'synced' | 'error'

export type CloudLoadResult<T> = {
  configured: boolean
  data: T | null
  updatedAt?: string
}

export type ExternalInquiryLoadResult<T> = {
  configured: boolean
  items: T[]
  updatedAt?: string
}

export async function loadDiscordInquiries<T>(): Promise<ExternalInquiryLoadResult<T>> {
  const response = await fetch('/api/integrations/discord/inquiries', { credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (response.status === 503) return { configured: false, items: [] }
  if (!response.ok) throw new Error(body.error || 'Could not load Discord inquiries.')
  return {
    configured: Boolean(body.configured),
    items: Array.isArray(body.items) ? body.items as T[] : [],
    updatedAt: body.updatedAt,
  }
}

let saveQueue: Promise<unknown> = Promise.resolve()

export async function loadCloudStore<T>(): Promise<CloudLoadResult<T>> {
  const response = await fetch('/api/store', { credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (response.status === 503) return { configured: false, data: null }
  if (!response.ok) throw new Error(body.error || 'Could not load the cloud database.')
  return {
    configured: Boolean(body.configured),
    data: (body.data ?? null) as T | null,
    updatedAt: body.updatedAt,
  }
}

async function saveCloudStoreNow<T>(data: T) {
  const response = await fetch('/api/store', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ data }),
  })
  const body = await response.json().catch(() => ({}))
  if (response.status === 503) return { configured: false as const }
  if (!response.ok) throw new Error(body.error || 'Could not save to the cloud database.')
  return { configured: true as const, updatedAt: body.updatedAt as string | undefined }
}

export function queueCloudStoreSave<T>(data: T) {
  saveQueue = saveQueue.then(() => saveCloudStoreNow(data), () => saveCloudStoreNow(data))
  return saveQueue as Promise<{ configured: boolean; updatedAt?: string }>
}
