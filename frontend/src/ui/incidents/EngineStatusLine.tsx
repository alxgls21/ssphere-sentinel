import type { EngineStatus } from '@/api/types'
import type { Resource } from '@/hooks/useResource'
import { ENGINE_HEALTH, ENGINE_WORD, engineNeedsAttention, engineSentence } from '@/lib/incidents'
import { StatusTag } from '@/ui/status'

/**
 * The alert engine's state in one line, for where a banner has no room (the Overview's panel): the
 * mark and word first, then what it means. Drawn only when the engine is not simply running, or its
 * state could not be read: a running engine needs no line there, and a state that is not known
 * is never drawn as fine.
 */
export function EngineStatusLine({ resource }: { resource: Resource<EngineStatus> }) {
  const { data, error } = resource
  if (!data) {
    return error ? (
      <p className="type-body flex min-w-0 items-center gap-2" title={error.message}>
        <StatusTag status="unknown" word="ENGINE UNKNOWN" />
        <span className="min-w-0 flex-1 truncate">its state could not be read</span>
      </p>
    ) : null
  }
  if (!engineNeedsAttention(data)) return null
  const sentence = engineSentence(data, Date.parse(data.generatedAt))
  return (
    <p className="type-body flex min-w-0 items-center gap-2" title={sentence}>
      <StatusTag status={ENGINE_HEALTH[data.state]} word={ENGINE_WORD[data.state]} />
      <span className="min-w-0 flex-1 truncate">{sentence}</span>
    </p>
  )
}
