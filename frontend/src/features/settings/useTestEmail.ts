import { useEffect, useState } from 'react'
import { useApi } from '@/api/context'
import { ApiError, isAbortError } from '@/api/errors'
import type { NotifierState, TestEmail, TestEmailAnswer } from '@/api/types'
import { isTestEmailOpen } from '@/lib/settings'

/** How long to wait between two readings of a test email that is not final, and the longest after failures. */
export const POLL_MS = 3000
export const POLL_MAX_MS = 30_000

export type PollTrouble = 'unreadable' | 'gone' | null

/**
 * Follows the user's latest test email. It asks for it again only while it is queued or being
 * sent, and stops at the first final state (sent, failed, cancelled or expired), on unmount, and
 * when the server says it is gone. A reading that fails is said, and tried again more slowly: it
 * never changes what the test email was last known to be.
 */
export function useTestEmail(initial: TestEmail | null, initialAsOf: string) {
  const api = useApi()
  const [latest, setLatest] = useState<TestEmail | null>(initial)
  // The clock of what is held: the answer's own time, so an age is told as of when it was read.
  const [asOf, setAsOf] = useState(initialAsOf)
  const [notifier, setNotifier] = useState<NotifierState | null>(null)
  const [trouble, setTrouble] = useState<PollTrouble>(null)

  // A newer reading from outside (the settings were read again) replaces what is held.
  const [seen, setSeen] = useState(initial)
  if (initial !== seen) {
    setSeen(initial)
    setLatest(initial)
    setAsOf(initialAsOf)
    setTrouble(null)
  }

  const id = latest?.id
  const open = latest !== null && isTestEmailOpen(latest.status)

  useEffect(() => {
    if (id === undefined || !open) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const schedule = () => {
      const wait = Math.min(POLL_MS * 2 ** failures, POLL_MAX_MS)
      timer = setTimeout(() => void read(), wait)
    }
    const read = async () => {
      try {
        const answer = await api.getTestEmail(id, { signal: controller.signal })
        if (controller.signal.aborted) return
        failures = 0
        setTrouble(null)
        setLatest(answer.item)
        setAsOf(answer.generatedAt)
        setNotifier(answer.notifier.state)
        // A final state ends the polling: the effect is torn down by the render that follows.
        if (isTestEmailOpen(answer.item.status)) schedule()
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        if (error instanceof ApiError && error.status === 404) {
          // Not the user's, or purged: there is nothing left to follow.
          setTrouble('gone')
          return
        }
        failures += 1
        setTrouble('unreadable')
        schedule()
      }
    }
    schedule()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [api, id, open])

  return {
    latest,
    asOf,
    notifier,
    trouble,
    /** A test email was just asked for: it is the one to follow. */
    accept: (answer: TestEmailAnswer) => {
      setLatest(answer.item)
      setAsOf(answer.generatedAt)
      setNotifier(answer.notifier.state)
      setTrouble(null)
    },
  }
}
