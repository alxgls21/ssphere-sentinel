import { useContext, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { CustomerDetail, CustomerRecord, SiteRecord } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewSearch, useViewTo } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { useSaveForm } from '@/hooks/useSaveForm'
import { cn } from '@/lib/cn'
import { DeleteConfirm } from '@/ui/DeleteConfirm'
import { FormNotice } from '@/ui/FormNotice'
import { Panel } from '@/ui/Panel'
import { Button, FieldInput, FieldTextArea } from '@/ui/controls'
import { buttonStyle } from '@/ui/controls/buttonStyle'
import { EmptyState, Notice, Skeleton } from '@/ui/states'
import { BackLink, CELL, HEAD, NAME_LINK, NotPermitted, ROW } from './AdminParts'
import { useArrivalState, useListBack, useRowOpen } from './adminHooks'
import { customerHolds } from './adminModel'
import {
  CUSTOMER_FIELDS,
  EMPTY_CUSTOMER,
  LIMITS,
  customerDraft,
  customerInput,
  customerPatch,
  validateCustomer,
  type CustomerDraft,
} from './customersModel'
import { NEW_SITE_PATH, customerPath, sitePath } from './sections'

function SitesTable({ sites }: { sites: readonly SiteRecord[] }) {
  const viewTo = useViewTo()
  const open = useRowOpen()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Sites" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th scope="col" className={cn(HEAD, 'pl-4')}>
              NAME
            </th>
            <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
              SERVERS
            </th>
            <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
              DEVICES
            </th>
            <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
              TARGETS
            </th>
            <th scope="col" className={cn(HEAD, 'hidden max-w-64 pr-3 @2xl:table-cell')}>
              DESCRIPTION
            </th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => {
            const to = viewTo(sitePath(site.id))
            return (
              <tr key={site.id} className={ROW} onClick={open(to)}>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'max-w-72 min-w-40 pr-2 pl-4')}>
                  <Link to={to} className={NAME_LINK}>
                    <span className="min-w-0 truncate">{site.name}</span>
                  </Link>
                </td>
                <td className={cn(CELL, 'type-data tnum px-3 text-right')}>{site.servers}</td>
                <td className={cn(CELL, 'type-data tnum px-3 text-right')}>{site.devices}</td>
                <td className={cn(CELL, 'type-data tnum px-3 text-right')}>{site.targets}</td>
                <td
                  title={site.description}
                  className={cn(
                    CELL,
                    'type-body hidden max-w-64 truncate pr-3 text-fg-muted @2xl:table-cell',
                  )}
                >
                  {site.description}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface EditorProps {
  record?: CustomerRecord
  onSaved: (detail: CustomerDetail) => void
  onCreated: (detail: CustomerDetail) => void
}

/** The form of a customer: the name and the notes, saved as a whole on creation and as a change after. */
function Editor({ record, onSaved, onCreated }: EditorProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState<CustomerDraft>(() =>
    record ? customerDraft(record) : EMPTY_CUSTOMER,
  )
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(CUSTOMER_FIELDS, shell?.announce, summary)
  const taken =
    form.failure?.code === 'customer_exists' && form.failure.message ? [form.failure.message] : null
  const errors = { ...form.errors, ...(taken ? { name: taken } : {}) }
  const lines = taken ? [] : form.lines
  const patch = record ? customerPatch(draft, record) : null
  const changed = record ? patch !== null : true

  const edit = (changes: Partial<CustomerDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    form.touched()
  }

  const submit = () =>
    form.submit(
      validateCustomer(draft),
      async () => {
        if (record) {
          const body = customerPatch(draft, record)
          if (body === null) return
          onSaved(await api.updateCustomer(record.id, body))
          shell?.announce('Customer saved.')
        } else {
          onCreated(await api.createCustomer(customerInput(draft)))
          shell?.announce('Customer created.')
        }
      },
      { failed: 'The customer was not saved.' },
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
        <FieldInput
          label="Name"
          value={draft.name}
          onChange={(name) => edit({ name })}
          error={errors.name}
          input={{ disabled: form.saving, autoComplete: 'off', spellCheck: false, required: true }}
          hint={`Unique, in any case; up to ${LIMITS.name} characters.`}
        />
        <FieldTextArea
          label="Notes"
          value={draft.notes}
          onChange={(notes) => edit({ notes })}
          error={errors.notes}
          textarea={{ disabled: form.saving }}
          hint="Optional, for the operators."
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={form.saving || !changed}
          aria-busy={form.saving}
        >
          {form.saving ? 'Saving…' : record ? 'Save changes' : 'Create customer'}
        </Button>
        {record && !changed ? (
          <span className="type-body text-fg-muted">Nothing changed yet.</span>
        ) : null}
      </div>
    </form>
  )
}

/**
 * Settings > Customers & sites > one customer, or a new one: its name and notes, its sites (each
 * on its own page, and a new one from here), and its deletion, refused by the server while
 * anything still belongs to it. Nothing is ever deleted along with a customer.
 */
export default function CustomerPage() {
  const api = useApi()
  const { id } = useParams()
  const creating = id === undefined
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const view = useViewSearch()
  const shell = useContext(ShellContext)
  const { capabilities } = useAuth()
  const may = capabilities.manageCustomers
  const back = useListBack('/settings/customers', view)
  const arrival = useArrivalState<{ created?: boolean }>()

  const detail = useResource(`customer:${id ?? 'new'}:${may}`, async (signal) =>
    may && id !== undefined ? api.getCustomer(id, { signal }) : null,
  )
  const [saved, setSaved] = useState<{ at: string | undefined; detail: CustomerDetail } | null>(
    null,
  )
  if (saved !== null && saved.at !== id) setSaved(null)
  const current = saved !== null && saved.at === id ? saved.detail : (detail.data ?? undefined)
  const record = current?.item

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
    detail.error instanceof ApiError && detail.error.status === 404 && current === undefined
  const loading = !creating && record === undefined
  const holds = record ? customerHolds(record) : ''

  const remove = async () => {
    if (!record) return
    setDeleting(true)
    setProblem(null)
    try {
      const gone = await api.deleteCustomer(record.id)
      shell?.announce(`Customer “${gone.deleted.name}” deleted.`)
      void navigate(viewTo('/settings/customers'), {
        replace: true,
        state: { deleted: gone.deleted.name },
      })
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'The customer could not be deleted: the server could not be reached.',
      )
      shell?.announce('The customer was not deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <BackLink to={back}>Customers & sites</BackLink>
        <h2 className="type-title">
          {creating ? (
            'New customer'
          ) : record ? (
            record.name
          ) : detail.error ? (
            'Customer'
          ) : (
            <Skeleton className="h-5 w-40" />
          )}
        </h2>
      </header>

      {arrival.created && !saved ? (
        <Notice status="healthy" word="CREATED" live="status">
          The customer is created. Add its sites below: everything monitored is placed on a site.
        </Notice>
      ) : null}
      {saved ? (
        <Notice status="healthy" word="SAVED" live="status">
          The customer is saved.
        </Notice>
      ) : null}

      {notFound ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState title="Customer not found" hint="It does not exist, or it was deleted." />
        </div>
      ) : (
        <Panel
          title="Customer"
          features="settings"
          scope="NOW"
          status={loading ? (detail.error ? 'error' : 'loading') : 'success'}
          error={loading ? detail.error : null}
          onRetry={detail.refetch}
          skeleton={<div className="h-40" />}
          className="max-w-4xl"
        >
          {creating || record ? (
            <Editor
              key={record ? `${record.id}:${record.updatedAt}` : 'new'}
              record={record}
              onSaved={(next) => setSaved({ at: id, detail: next })}
              onCreated={(next) =>
                void navigate(viewTo(customerPath(next.item.id)), {
                  state: { created: true, list: back.search },
                })
              }
            />
          ) : null}
        </Panel>
      )}

      {record && current ? (
        <>
          <Panel
            title="Sites"
            features="settings"
            scope="NOW"
            count={current.sites.length}
            actions={
              <Link
                to={viewTo(NEW_SITE_PATH, { of: record.id })}
                className={buttonStyle('secondary', { size: 'sm' })}
              >
                Add site
              </Link>
            }
            isEmpty={current.sites.length === 0}
            empty={
              <EmptyState
                title="No sites yet"
                hint="A site is where servers, devices and targets are placed, and what access is granted on. Add one."
              />
            }
            flush
            className="max-w-4xl"
          >
            <SitesTable sites={current.sites} />
          </Panel>

          <Panel title="Delete" features="settings" scope="NOW" className="max-w-4xl">
            {confirm ? (
              <DeleteConfirm
                kind="customer"
                name={record.name}
                busy={deleting}
                problem={problem}
                onConfirm={() => void remove()}
                onCancel={() => setConfirm(false)}
              >
                <p>
                  The customer and the access grants to it go. Nothing else is deleted along with
                  it.
                </p>
                <p>
                  The server refuses while sites, monitored domains or alert rules still belong to
                  it: move or delete them first.
                </p>
              </DeleteConfirm>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => setConfirm(true)}
                  disabled={holds !== ''}
                  aria-describedby={holds ? 'customer-holds' : undefined}
                >
                  Delete customer
                </Button>
                <span id="customer-holds" className="type-body text-fg-muted">
                  {holds
                    ? `It still has ${holds}: move or delete them first. Nothing is deleted along with a customer.`
                    : 'Nothing belongs to it any more. Its access grants go with it; the audit trail keeps its name.'}
                </span>
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}
