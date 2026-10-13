import { createContext, useContext } from 'react'
import type { ApiMode } from '@/config/runtime'

/** Where the data comes from. Tests and the design gallery render without the app's providers, in mock mode. */
export const ModeContext = createContext<ApiMode>('mock')

export const useApiMode = (): ApiMode => useContext(ModeContext)
