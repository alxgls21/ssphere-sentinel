import { Component, type ReactNode } from 'react'
import type { FeatureId } from '@/config/features'
import { Panel } from './Panel'

interface PanelBoundaryProps {
  title: string
  features: FeatureId | readonly FeatureId[]
  index?: number
  /** The same placement classes as the panel it guards, so a failure keeps its grid cell. */
  className?: string
  children: ReactNode
}

interface PanelBoundaryState {
  error: Error | null
}

/**
 * Contains a panel that throws while rendering (or whose lazy chunk fails to
 * load), so one broken panel leaves the other five readable instead of
 * replacing the whole screen. The fallback is the panel's own frame in its
 * error state, with Retry.
 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PanelBoundaryState {
    return { error }
  }

  override render() {
    const { error } = this.state
    const { title, features, index, className, children } = this.props
    if (!error) return children
    return (
      <Panel
        title={title}
        features={features}
        index={index}
        className={className}
        status="error"
        error={error}
        onRetry={() => this.setState({ error: null })}
      />
    )
  }
}
