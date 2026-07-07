import { useEffect, useState } from 'react'

/** True when the viewport is at or below `px` wide. Tracks live resizes. */
export function useMediaBelow(px: number): boolean {
  const [below, setBelow] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia(`(max-width: ${px}px)`).matches
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px}px)`)
    const onChange = () => setBelow(mq.matches)
    onChange()
    // addEventListener isn't available on older Safari's MediaQueryList.
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else mq.addListener(onChange)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else mq.removeListener(onChange)
    }
  }, [px])
  return below
}
