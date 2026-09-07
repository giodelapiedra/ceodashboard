import { useEffect, useState } from 'react'
import { weeklyKpiApi } from '../api/weeklyKpi.api'
import { KpiModel } from '../types'

/**
 * The 30-signal registry, for a container that needs to render or explain a
 * Weekly Check-In score.
 *
 * Belongs in a CONTAINER — the page, the drawer, the history list — and not in
 * a presentational component. weeklyKpi.ui.tsx renders what it is handed and
 * fetches nothing; putting this hook inside one of its components would have
 * made a file of design tokens and form atoms into something that talks to the
 * API, and every consumer would then be doing I/O without asking for it.
 *
 * `version`: omit for the current model (what the FORM asks the physio). Pass a
 * report's `effectiveness.model_version` to explain a PAST score with the
 * weights and band labels that actually produced it — passing nothing there
 * would describe an old score using today's model.
 *
 * The fetch is cached per version inside weeklyKpiApi.model, so mounting this
 * in several places costs one request per version, and a component that mounts
 * after the first fetch resolves gets the model without a flash of loading.
 */
export function useKpiModel(version?: string | null): {
  model: KpiModel | null
  error: string
  loading: boolean
} {
  const [model,   setModel]   = useState<KpiModel | null>(null)
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    weeklyKpiApi.model(version ?? undefined)
      .then(m => { if (alive) { setModel(m); setError('') } })
      .catch((e: any) => {
        if (alive) {
          setModel(null)
          setError(e.response?.data?.error?.message || 'Could not load the check-in questions')
        }
      })
      .finally(() => { if (alive) setLoading(false) })
    // Guards a state update on a component the physio has navigated away from —
    // the drawer in particular is opened and closed repeatedly, and `version`
    // changes as they page through their history.
    return () => { alive = false }
  }, [version])

  return { model, error, loading }
}
