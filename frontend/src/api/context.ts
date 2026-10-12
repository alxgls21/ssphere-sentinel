import { createContext, useContext } from 'react'
import type { SentinelApi } from './client'

export const ApiContext = createContext<SentinelApi | null>(null)

export function useApi(): SentinelApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error('useApi must be used inside <ApiContext.Provider>')
  return api
}
