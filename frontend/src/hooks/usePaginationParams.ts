import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

const VALID_LIMITS = new Set([25, 50, 100, 200])

/**
 * Manages pagination state (page, limit) in URL query params.
 * Clean URLs: page 1 and default limit are omitted from the URL.
 * Explicit page navigation (Next/Prev) pushes history entries.
 * Filter-triggered resets use replace so they don't pollute history.
 */
export function usePaginationParams(defaultLimit = 50) {
  const [searchParams, setSearchParams] = useSearchParams()

  const page = Math.max(1, Number(searchParams.get('page') ?? 1))
  const limit = VALID_LIMITS.has(Number(searchParams.get('limit')))
    ? Number(searchParams.get('limit'))
    : defaultLimit
  const offset = (page - 1) * limit

  const setOffset = (newOffset: number) => {
    const newPage = Math.floor(newOffset / limit) + 1
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newPage <= 1) next.delete('page')
      else next.set('page', String(newPage))
      return next
    })
  }

  const setLimit = (newLimit: number) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newLimit === defaultLimit) next.delete('limit')
      else next.set('limit', String(newLimit))
      next.delete('page')
      return next
    }, { replace: true })
  }

  // Stable reference — safe to include in useEffect dependency arrays.
  // Use this when filters change to reset back to page 1 without adding a
  // history entry.
  const resetPage = useCallback(() => {
    setSearchParams(prev => {
      if (!prev.has('page')) return prev
      const next = new URLSearchParams(prev)
      next.delete('page')
      return next
    }, { replace: true })
  }, [setSearchParams])

  return { page, limit, offset, setOffset, setLimit, resetPage }
}
