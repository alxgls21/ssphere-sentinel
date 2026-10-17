import type { ReactNode } from 'react'
import { Panel, type PanelProps } from '@/ui/Panel'

interface SamplePanelProps extends Omit<PanelProps, 'features' | 'footer' | 'plannedNote'> {
  /** Why the content is a sample: what the backend or the console API does not serve. */
  note: string
  footer?: ReactNode
}

/**
 * A gallery panel holding sample content for something the console API does not serve. It is
 * drawn as a mock panel, never as a live one, and its footer says what the content is, so no
 * figure in the gallery can pass for a measurement. The Overview itself never does this: there
 * a panel with nothing behind it shows no figure at all.
 */
export function SamplePanel({ note, footer, ...props }: SamplePanelProps) {
  return (
    <Panel
      {...props}
      features="servers"
      footer={
        <>
          <span className="truncate">Sample data. {note}</span>
          {footer}
        </>
      }
    />
  )
}
