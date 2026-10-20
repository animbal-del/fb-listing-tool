import { useEffect, useRef } from 'react'

// setInterval that pauses while the browser tab is hidden and runs once
// as soon as the tab is visible again (keeps background tabs off the database)
export function useVisibleInterval(callback, ms) {
  const saved = useRef(callback)
  useEffect(() => { saved.current = callback }, [callback])

  useEffect(() => {
    let id = null
    const start = () => {
      if (id === null) id = setInterval(() => saved.current(), ms)
    }
    const stop = () => {
      if (id !== null) clearInterval(id)
      id = null
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        saved.current()
        start()
      }
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ms])
}
