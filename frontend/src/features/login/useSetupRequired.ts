import { useEffect, useState } from 'react'
import { isAbortError } from '@/api/errors'
import { useAuth } from '@/app/auth/auth'

/**
 * Whether the installation has no user yet, asked once while `enabled`. Null until the server has
 * answered. A check that fails says nothing is required: the sign-in page must never be blocked by it,
 * and the server refuses a setup that is not pending anyway.
 */
export function useSetupRequired(enabled: boolean): boolean | null {
  const { checkSetup } = useAuth()
  const [required, setRequired] = useState<boolean | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    checkSetup(controller.signal).then(
      (answer) => {
        if (!controller.signal.aborted) setRequired(answer)
      },
      (error: unknown) => {
        if (!isAbortError(error) && !controller.signal.aborted) setRequired(false)
      },
    )
    return () => controller.abort()
  }, [enabled, checkSetup])
  return required
}
