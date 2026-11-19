import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'

/** How many a page can hold. The first is the default for long lists that someone scans. */
export const PAGE_SIZES = [5, 20, 50] as const
const DEFAULT_SIZE = 20

export type Paged<T> = {
  /** The rows of the current page. */
  rows: T[]
  page: number
  pages: number
  size: number
  total: number
  setPage: (page: number) => void
  setSize: (size: number) => void
}

const readSize = (key: string) => {
  try {
    const saved = Number(window.localStorage.getItem(key))
    return (PAGE_SIZES as readonly number[]).includes(saved) ? saved : DEFAULT_SIZE
  } catch {
    return DEFAULT_SIZE
  }
}

/**
 * One page of a list shown in the browser. The page size is kept per list (`sizeKey`) in this browser; the page
 * goes back to the first whenever `resetKey` changes (a new search, filter or sort), and never past the last.
 */
export function usePaged<T>(items: T[], sizeKey: string, resetKey: string): Paged<T> {
  const [size, setSizeNow] = useState(() => readSize(sizeKey))
  const [page, setPage] = useState(1)
  const [seen, setSeen] = useState(resetKey)
  if (seen !== resetKey) {
    setSeen(resetKey)
    setPage(1)
  }
  const pages = Math.max(1, Math.ceil(items.length / size))
  const current = Math.min(page, pages)
  const setSize = (next: number) => {
    setSizeNow(next)
    setPage(1)
    try {
      window.localStorage.setItem(sizeKey, String(next))
    } catch {
      /* The size then lasts until the page reloads. */
    }
  }
  return {
    rows: items.slice((current - 1) * size, current * size),
    page: current,
    pages,
    size,
    total: items.length,
    setPage,
    setSize,
  }
}

/** Showing 1–20 of 115 · Per page 5 / 20 / 50 · Previous · Page 1 of 6 · Next. */
export function ListPager<T>({ paged, noun }: { paged: Paged<T>; noun: [one: string, many: string] }) {
  const { page, pages, size, total } = paged
  const first = total ? (page - 1) * size + 1 : 0
  const last = Math.min(page * size, total)
  return (
    <div className="list-pager">
      <span role="status">
        {total ? `Showing ${first}–${last} of ${total} ${total === 1 ? noun[0] : noun[1]}` : `No ${noun[1]}`}
      </span>
      <label className="list-pager-size">
        Per page
        <select value={size} onChange={event => paged.setSize(Number(event.target.value))}>
          {PAGE_SIZES.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <div className="list-pager-buttons">
        <button
          type="button"
          className="secondary compact"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => paged.setPage(page - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className="secondary compact"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => paged.setPage(page + 1)}
        >
          Next
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
