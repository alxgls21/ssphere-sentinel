import { useContext, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { ScopeOptions, SiteDetail, SiteRecord } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewSearch, useViewTo } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { useSaveForm } from '@/hooks/useSaveForm'
import { DeleteConfirm } from '@/ui/DeleteConfirm'
import { FormNotice } from '@/ui/FormNotice'
import { Panel } from '@/ui/Panel'
import { Button, FieldInput, FieldSelect, FieldTextArea } from '@/ui/controls'
import { EmptyState, Notice, Skeleton } from '@/ui/states'
import { BackLink, NotPermitted } from './AdminParts'
import { useArrivalState, useListBack } from './adminHooks'
import { customerChoices, siteHolds } from './adminModel'
import {
  LIMITS,
  SITE_FIELDS,
  newSiteDraft,
  siteDraft,
  siteInput,
  sitePatch,
  validateSite,
  type SiteDraft,
} from './customersModel'
import { customerPath, sitePath } from './sections'

interface EditorProps {
  record?: SiteRecord
  /** The customer the form was opened for, on creation. */
  openedFor: string
  scope: ScopeOptions
  onSaved: (detail: SiteDetail) => void
  onCreated: (detail: SiteDetail) => void
}

/** The form of a site: its customer (a move, once it exists), its name and description. */
function Editor({ record, openedFor, scope, onSaved, onCreated }: EditorProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState<SiteDraft>(() =>
    record ? siteDraft(record) : newSiteDraft(openedFor),
  )
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(SITE_FIELDS, shell?.announce, summary)
  const taken =
    form.failure?.code === 'site_exists' && form.failure.message ? [form.failure.message] : null
  const errors = { ...form.errors, ...(taken ? { name: taken } : {}) }
  const lines = taken ? [] : form.lines
  const changed = record ? sitePatch(draft, record) !== null : true
  const moving = record !== undefined && draft.customerId !== record.customerId

  const edit = (changes: Partial<SiteDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    form.touched()
  }

  const submit = () =>
    form.submit(
      validateSite(draft),
      async () => {
        if (record) {
          const body = sitePatch(draft, record)
          if (body === null) return
          onSaved(await api.updateSite(record.id, body))
          shell?.announce('Site saved.')
        } else {
          onCreated(await api.createSite(siteInput(draft)))
          shell?.announce('Site created.')
        }
      },
      { failed: 'The site was not saved.' },
    )

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      aria-busy={form.saving}
      onSubmit={(event) => {
        event.preventDefault()
        if (!form.saving) void submit()
      }}
    >
      <FormNotice
        ref={summary}
        invalid={Object.keys(errors).filter(
          (name) => (errors[name as keyof typeof errors]?.length ?? 0) > 0,
        )}
        lines={lines}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <FieldSelect
          label="Customer"
          value={draft.customerId}
          onChange={(customerId) => edit({ customerId })}
          options={customerChoices(scope)}
          error={errors.customerId}
          disabled={form.saving}
          hint={
            moving
              ? 'Moving the site changes who sees everything on it: the accounts granted the new customer, no longer the old one’s.'
              : 'The customer the site belongs to. Its accounts see everything placed on the site.'
          }
        />
        <FieldInput
          label="Name"
          value={draft.name}
          onChange={(name) => edit({ name })}
          error={errors.name}
          input={{ disabled: form.saving, autoComplete: 'off', spellCheck: false, required: true }}
          hint={`Unique within the customer, in any case; up to ${LIMITS.name} characters.`}
        />
        <FieldTextArea
          label="Description"
          value={draft.description}
          onChange={(description) => edit({ description })}
          error={errors.description}
          textarea={{ disabled: form.saving }}
          hint="Optional: the address, the floor, what is there."
          className="md:col-span-2"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={form.saving || !changed}
          aria-busy={form.saving}
        >
          {form.saving
            ? 'Saving…'
            : record
              ? moving
                ? 'Save and move'
                : 'Save changes'
              : 'Create site'}
        </Button>
        {record && !changed ? (
          <span className="type-body text-fg-muted">Nothing changed yet.</span>
        ) : null}
      </div>
    </form>
  )
}

/**
 * Settings > Customers & sites > one site, or a new one (opened from its customer): its customer,
 * name and description, and its deletion, refused by the server while anything is still placed on
 * it. Nothing is ever deleted along with a site.
 */
export default function SitePage() {
  const api = useApi()
  const { id } = useParams()
  const [params] = useSearchParams()
  const creating = id === undefined
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const view = useViewSearch()
  const shell = useContext(ShellContext)
  const { capabilities } = useAuth()
  const may = capabilities.manageCustomers
  const arrival = useArrivalState<{ created?: boolean }>()

  const detail = useResource(`site:${id ?? 'new'}:${may}`, async (signal) =>
    may && id !== undefined ? api.getSite(id, { signal }) : null,
  )
  const scope = useResource<ScopeOptions | null>(`site-scope:${may}`, async (signal) =>
    may ? api.getScopeOptions({ signal }) : null,
  )
  const [saved, setSaved] = useState<{ at: string | undefined; detail: SiteDetail } | null>(null)
  if (saved !== null && saved.at !== id) setSaved(null)
  const record = saved !== null && saved.at === id ? saved.detail.item : detail.data?.item
  // `of`, never `customer`: that name is the console's scope (the top bar), which this page must not change.
  const customerId = record?.customerId ?? params.get('of') ?? ''
  const back = useListBack(customerId ? customerPath(customerId) : '/settings/customers', view)

  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  if (!may) {
    return (
      <NotPermitted
        what="change customers and sites"
        hint="The console offers this only to an account that may change alert rules and holds the admin's permissions on customers and sites, with access to every customer. The server checks it on every request."
      />
    )
  }

  const notFound =
    detail.error instanceof ApiError && detail.error.status === 404 && record === undefined
  const loading = scope.data == null || (!creating && record === undefined)
  const failed = scope.error ?? detail.error
  const holds = record ? siteHolds(record) : ''

  const remove = async () => {
    if (!record) return
    setDeleting(true)
    setProblem(null)
    try {
      const gone = await api.deleteSite(record.id)
      shell?.announce(`Site “${gone.deleted.name}” deleted.`)
      void navigate(viewTo(customerPath(record.customerId)), { replace: true })
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'The site could not be deleted: the server could not be reached.',
      )
      shell?.announce('The site was not deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <BackLink to={back}>{record ? record.customerName : 'Customers & sites'}</BackLink>
        <h2 className="type-title">
          {creating ? (
            'New site'
          ) : record ? (
            record.name
          ) : failed ? (
            'Site'
          ) : (
            <Skeleton className="h-5 w-40" />
          )}
        </h2>
      </header>

      {arrival.created && !saved ? (
        <Notice status="healthy" word="CREATED" live="status">
          The site is created. Servers, devices and targets can now be placed on it.
        </Notice>
      ) : null}
      {saved ? (
        <Notice status="healthy" word="SAVED" live="status">
          The site is saved.
        </Notice>
      ) : null}

      {notFound ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState title="Site not found" hint="It does not exist, or it was deleted." />
        </div>
      ) : (
        <Panel
          title="Site"
          features="settings"
          scope="NOW"
          status={loading ? (failed ? 'error' : 'loading') : 'success'}
          error={loading ? failed : null}
          onRetry={() => {
            scope.refetch()
            detail.refetch()
          }}
          skeleton={<div className="h-40" />}
          className="max-w-4xl"
        >
          {scope.data && (creating || record) ? (
            <Editor
              key={record ? `${record.id}:${record.updatedAt}` : 'new'}
              record={record}
              openedFor={customerId}
              scope={scope.data}
              onSaved={(next) => setSaved({ at: id, detail: next })}
              onCreated={(next) =>
                void navigate(viewTo(sitePath(next.item.id)), { state: { created: true } })
              }
            />
          ) : null}
        </Panel>
      )}

      {record ? (
        <Panel title="Delete" features="settings" scope="NOW" className="max-w-4xl">
          {confirm ? (
            <DeleteConfirm
              kind="site"
              name={record.name}
              busy={deleting}
              problem={problem}
              onConfirm={() => void remove()}
              onCancel={() => setConfirm(false)}
            >
              <p>The site and the access grants to it go. Nothing else is deleted along with it.</p>
              <p>
                The server refuses while servers, devices, network targets, alert rules or incidents
                still belong to it: move or delete them first.
              </p>
            </DeleteConfirm>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => setConfirm(true)}
                disabled={holds !== ''}
                aria-describedby={holds ? 'site-holds' : undefined}
              >
                Delete site
              </Button>
              <span id="site-holds" className="type-body text-fg-muted">
                {holds
                  ? `It still has ${holds}: move or delete them first. Nothing is deleted along with a site.`
                  : 'Nothing is placed on it any more. Its access grants go with it; the audit trail keeps its name.'}
              </span>
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  )
}
