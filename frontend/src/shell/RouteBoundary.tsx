import { Component, type ReactNode } from 'react'
import { ErrorState } from '@/ui/states'

interface RouteBoundaryProps {
  /** A new key (the pathname) gives the next screen a clean slate. */
  resetKey: string
  children: ReactNode
}

interface RouteBoundaryState {
  error: Error | null
  resetKey: string
}

/**
 * Contains a screen that throws, or whose code chunk fails to load (offline,
 * or a deploy replaced it), so the sidebar and the rest of the shell stay
 * usable. Retry reloads the page: React.lazy remembers a failed import, so
 * rendering the same screen again could only fail the same way.
 */
export class RouteBoundary extends Component<RouteBoundaryProps, RouteBoundaryState> {
  override state: RouteBoundaryState = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<RouteBoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(
    props: RouteBoundaryProps,
    state: RouteBoundaryState,
  ): Partial<RouteBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <ErrorState
        title="This screen could not be loaded"
        message={error.message}
        onRetry={() => window.location.reload()}
      />
    )
  }
}
