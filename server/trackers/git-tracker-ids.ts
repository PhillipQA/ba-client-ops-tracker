/**
 * Stable ids for what a GIT Tracker ticket entry generates. The same entry, kind and key always give the same id
 * (a name-based UUID, version 5, under the entry's own id), so a retry after a lost response or a partial failure
 * finds the rows and tasks the first attempt made instead of making them again.
 */
import { createHash } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** RFC 4122 version 5 UUID of `name` in the `namespace` UUID. */
export function uuidV5(name: string, namespace: string): string {
  if (!UUID.test(namespace)) throw new Error('The namespace must be a UUID.')
  const space = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(space).update(name, 'utf8').digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The `idFor` that planGitGeneration takes, for one ticket entry. */
export const gitEntryIds = (entryId: string) => (kind: 'row' | 'work', key: string) => uuidV5(`${kind}:${key}`, entryId)
