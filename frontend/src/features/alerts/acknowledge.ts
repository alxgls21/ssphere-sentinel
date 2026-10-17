import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { IncidentDetail } from '@/api/types'
import { useOptionalAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'

/**
 * Acknowledging an incident: the one write of the Alerts screen. It marks an active incident as
 * seen and nothing else: the incident stays open, and nothing here resolves one. The write is never
 * aborted with the screen that sent it, and the outcome is always worded: done, already done by
 * someone else, refused, gone, ended, or not known because the server could not be reached.
 */

/** What a refused or failed acknowledgement says, by what the API answered. */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return 'You may not acknowledge incidents: your account lacks the permission.'
    if (error.status === 404) {
      return 'This incident no longer exists, or you may no longer see it. Nothing was acknowledged.'
    }
    if (error.status === 409) {
      return 'This incident has already ended, so there is nothing to acknowledge.'
    }
    if (error.code === 'network' || error.code === 'timeout') {
      // A write that got no answer may or may not have been applied: say so, and send them to look.
      return 'The server could not be reached, so it is not known whether the incident was acknowledged. Reload to check, then try again.'
    }
    return `The incident could not be acknowledged: ${error.message}`
  }
  return 'The incident could not be acknowledged.'
}

/** Who acknowledged, in the answer: this user, or someone who did it first (the API keeps the first). */
export function describeAcknowledged(
  detail: IncidentDetail,
  me: { username: string; displayName: string } | null,
): string {
  const { item } = detail
  const by = item.acknowledgedBy
  const mine = by !== null && me !== null && (by === me.username || by === me.displayName)
  if (item.status === 'active')
    return 'The incident is still active: the acknowledgement was not recorded.'
  if (by !== null && !mine && me !== null) {
    return `Already acknowledged by ${by}. It is still open.`
  }
  return `Acknowledged${by ? ` by ${by}` : ''}. It stays open until the condition clears.`
}

export interface AckNotice {
  id: string
  tone: 'ok' | 'error'
  text: string
}

interface Options {
  /** Runs after every attempt, whatever came of it: what is on screen may have changed. */
  onSettled?: (detail: IncidentDetail | null) => void
}

export function useAcknowledge({ onSettled }: Options = {}) {
  const api = useApi()
  const auth = useOptionalAuth()
  const shell = useContext(ShellContext)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<AckNotice | null>(null)
  const inFlight = useRef(false)
  const me = auth?.user ?? null
  const settled = useRef(onSettled)
  useEffect(() => {
    settled.current = onSettled
  })

  const acknowledge = useCallback(
    async (id: string): Promise<IncidentDetail | null> => {
      // One at a time: a second click while a write is out would only ask the same question twice.
      if (inFlight.current) return null
      inFlight.current = true
      setBusy(id)
      setNotice(null)
      let result: IncidentDetail | null = null
      let next: AckNotice
      try {
        result = await api.acknowledgeIncident(id)
        // An answer that still says active did not record it: that is not a success.
        next = {
          id,
          tone: result.item.status === 'active' ? 'error' : 'ok',
          text: describeAcknowledged(result, me),
        }
      } catch (error) {
        next = { id, tone: 'error', text: describeFailure(error) }
      }
      inFlight.current = false
      setBusy(null)
      setNotice(next)
      shell?.announce(next.text)
      settled.current?.(result)
      return result
    },
    [api, me, shell],
  )

  return { busy, notice, acknowledge, dismiss: () => setNotice(null) }
}
