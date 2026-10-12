import { useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { parseMockScenario, type MockScenario } from '@/api/mock/scenario'

export { MOCK_SCENARIO_SUMMARY, MOCK_SCENARIOS, type MockScenario } from '@/api/mock/scenario'

/**
 * The mock scenario lives in the URL (?mock=error), like the range and the
 * scope: one source of truth, so a reload, a shared link, the back button and
 * the command palette can never disagree. Absent means `normal`.
 */
export function useMockScenario(): MockScenario {
  const [params] = useSearchParams()
  return parseMockScenario(params.get('mock'))
}

export function useSetMockScenario(): (scenario: MockScenario) => void {
  const [, setParams] = useSearchParams()
  return useCallback(
    (scenario) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (scenario === 'normal') next.delete('mock')
          else next.set('mock', scenario)
          return next
        },
        { replace: true },
      ),
    [setParams],
  )
}
