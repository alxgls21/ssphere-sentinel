import { useContext, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { DomainVerification, VerificationAnswer } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { usePrefs } from '@/app/prefs'
import { useViewSearch } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { formatStamp } from '@/lib/format'
import { CodeBlock } from '@/ui/CodeBlock'
import { Panel } from '@/ui/Panel'
import { Button } from '@/ui/controls'
import { EmptyState, Notice, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { BackLink, NotPermitted } from './AdminParts'
import { useArrivalState, useListBack } from './adminHooks'
import {
  STATUS_DISPLAY,
  STATUS_MEANING,
  STATUS_WORD,
  verificationOver,
  verificationSentence,
} from './domainsModel'

/** How often a running verification is asked about again. */
const POLL_MS = 3000

/** What the server said about asking for a verification, in words the operator can act on. */
function askProblem(error: unknown): string {
  if (error instanceof ApiError && error.code === 'rate_limited' && error.retryAfterSeconds) {
    return `Verifications are limited: try again in ${error.retryAfterSeconds} seconds.`
  }
  if (error instanceof ApiError && error.message) return error.message
  return 'The verification was not requested: the server could not be reached.'
}

function Evidence({ verification }: { verification: DomainVerification }) {
  const { evidence } = verification
  if (!evidence || evidence.nameservers.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <h3 className="type-label text-fg-muted">
        Name servers asked ({evidence.nameserverCount}) for {evidence.zone}
      </h3>
      <table aria-label="Name servers asked" className="type-data w-full">
        <tbody>
          {evidence.nameservers.map((server) => (
            <tr key={`${server.name}:${server.address}`} className="border-b border-border">
              <th scope="row" className="py-1 pr-3 text-left font-normal">
                {server.name}
              </th>
              <td className="py-1 pr-3 text-fg-muted">{server.address}</td>
              <td className="py-1 text-right">{server.result}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Settings > Domains > one domain: what it is, the DNS record its customer adds to prove it, and the
 * verification that looks for the record in the domain's own name servers. A request that is waiting or
 * running is asked about every few seconds until it is over; the domain is read again then, since the
 * verification may have changed its state.
 */
export default function DomainPage() {
  const api = useApi()
  const { id = '' } = useParams()
  const shell = useContext(ShellContext)
  const { capabilities } = useAuth()
  const { tz } = usePrefs()
  const view = useViewSearch()
  const back = useListBack('/settings/domains', view)
  const arrival = useArrivalState<{ created?: boolean }>()
  const may = capabilities.viewDomains

  const detail = useResource(`domain:${id}:${may}`, async (signal) =>
    may ? api.getDomain(id, { signal }) : null,
  )
  const current = detail.data ?? undefined
  const record = current?.item

  // The verification being followed: the one just requested, else the latest the domain has.
  const [followed, setFollowed] = useState<VerificationAnswer | null>(null)
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const verification = followed?.item ?? current?.latestVerification ?? null
  const verifierState = followed?.verifier.state ?? null
  const active = verification !== null && !verificationOver(verification)

  const { refetch } = detail
  const verificationId = verification?.id ?? null
  useEffect(() => {
    if (!active || verificationId === null) return
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      // Look every few seconds until it is over; a failed look is simply tried again.
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_MS)
          signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
        })
        if (signal.aborted) return
        try {
          const answer = await api.getDomainVerification(id, verificationId, { signal })
          setFollowed(answer)
          if (verificationOver(answer.item)) {
            refetch()
            return
          }
        } catch {
          // Nothing is said until an answer comes.
        }
      }
    })()
    return () => controller.abort()
  }, [active, api, id, verificationId, refetch])

  const ask = async () => {
    setAsking(true)
    setProblem(null)
    try {
      const answer = await api.verifyDomain(id)
      setFollowed(answer)
      shell?.announce('Verification requested.')
    } catch (error) {
      setProblem(askProblem(error))
      shell?.announce('The verification was not requested.')
    } finally {
      setAsking(false)
    }
  }

  const notFound = detail.error instanceof ApiError && detail.error.status === 404
  const forbidden = detail.error instanceof ApiError && detail.error.status === 403
  if (!may || forbidden) {
    return (
      <NotPermitted
        what="see monitored domains"
        hint="The console offers this only to an account that holds the permissions on monitored domains and sees every customer. The server checks it on every request."
      />
    )
  }
  const nowMs = current ? Date.parse(current.generatedAt) : 0
  const loading = current === undefined

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <BackLink to={back}>Domains</BackLink>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="type-title">
            {record ? (
              record.displayName
            ) : detail.error ? (
              'Domain'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h2>
          {record ? (
            <StatusTag
              status={STATUS_DISPLAY[record.status]}
              word={STATUS_WORD[record.status]}
              variant="tag"
            />
          ) : null}
        </div>
        {record ? <p className="type-body text-fg-muted">{STATUS_MEANING[record.status]}</p> : null}
      </header>

      {arrival.created ? (
        <Notice status="healthy" word="ADDED" live="status">
          The domain is added. Put the record below in its DNS, then ask for a verification.
        </Notice>
      ) : null}

      {notFound ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState title="Domain not found" hint="It does not exist." />
        </div>
      ) : (
        <>
          <Panel
            title="Domain"
            features="settings"
            scope="NOW"
            status={loading ? (detail.error ? 'error' : 'loading') : 'success'}
            error={loading ? detail.error : null}
            onRetry={detail.refetch}
            skeleton={<div className="h-24" />}
            className="max-w-4xl"
          >
            {record ? (
              <dl className="type-body grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <div>
                  <dt className="type-label text-fg-muted">Customer</dt>
                  <dd>{record.customer.name}</dd>
                </div>
                <div>
                  <dt className="type-label text-fg-muted">DNS name</dt>
                  <dd className="type-data">{record.name}</dd>
                </div>
                <div>
                  <dt className="type-label text-fg-muted">Added</dt>
                  <dd>
                    {formatStamp(Date.parse(record.createdAt), tz, nowMs)} by {record.createdBy}
                  </dd>
                </div>
                <div>
                  <dt className="type-label text-fg-muted">Last checked</dt>
                  <dd>
                    {record.lastCheckedAt
                      ? `${formatStamp(Date.parse(record.lastCheckedAt), tz, nowMs)}${record.lastOutcome ? `: ${record.lastOutcome.label}` : ''}`
                      : 'Never'}
                  </dd>
                </div>
              </dl>
            ) : null}
          </Panel>

          {current ? (
            <>
              <Panel title="DNS record" features="settings" scope="NOW" className="max-w-4xl">
                <CodeBlock
                  title="TXT record to add"
                  what="Record"
                  text={`Type:  ${current.record.type}\nName:  ${current.record.name}\nValue: ${current.record.value}`}
                >
                  Add it to the DNS of {record?.name}. It is public DNS material, not a secret, and
                  this customer has its own value for the same domain. A change can take a while to
                  spread.
                </CodeBlock>
              </Panel>

              <Panel
                title="Verification"
                features="settings"
                scope="NOW"
                actions={
                  capabilities.verifyDomains ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void ask()}
                      disabled={asking || active}
                      aria-busy={asking || active}
                    >
                      {asking ? 'Requesting…' : active ? 'Checking…' : 'Verify now'}
                    </Button>
                  ) : undefined
                }
                className="max-w-4xl"
              >
                <div className="flex flex-col gap-3">
                  {problem ? (
                    <Notice status="warning" word="NOT REQUESTED" live="alert">
                      {problem}
                    </Notice>
                  ) : null}
                  {verifierState === 'failed' || verifierState === 'stale' ? (
                    <Notice status="warning" word="VERIFIER" live="status">
                      The domain verifier is not running as it should, so a request may wait for a
                      while.
                    </Notice>
                  ) : null}
                  {verification ? (
                    <>
                      <p className="type-body" aria-live="polite">
                        {verificationSentence(verification)}
                      </p>
                      <p className="type-data text-fg-muted">
                        Requested {formatStamp(Date.parse(verification.createdAt), tz, nowMs)} by{' '}
                        {verification.requestedBy}
                        {verification.finishedAt
                          ? `, finished ${formatStamp(Date.parse(verification.finishedAt), tz, nowMs)}`
                          : ''}
                        .
                      </p>
                      <Evidence verification={verification} />
                    </>
                  ) : (
                    <p className="type-body text-fg-muted">
                      Not verified yet. Add the record, then ask for a verification.
                    </p>
                  )}
                </div>
              </Panel>
            </>
          ) : null}
        </>
      )}
    </div>
  )
}
