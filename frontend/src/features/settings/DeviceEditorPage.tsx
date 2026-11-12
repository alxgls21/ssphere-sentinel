import { useContext, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type {
  AgentOption,
  DeviceType,
  InventoryDevice,
  InventoryDeviceDetail,
  ScopeOptions,
  SnmpVersion,
} from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewSearch, useViewTo } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { useSaveForm } from '@/hooks/useSaveForm'
import { cn } from '@/lib/cn'
import { DeleteConfirm } from '@/ui/DeleteConfirm'
import { FormNotice } from '@/ui/FormNotice'
import { Panel } from '@/ui/Panel'
import { Button, Checkbox, FieldInput, FieldSelect, FieldTextArea } from '@/ui/controls'
import { EmptyState, Notice, Skeleton } from '@/ui/states'
import { STATUS_TEXT, StatusTag } from '@/ui/status'
import { BackLink, NotPermitted } from './AdminParts'
import { useArrivalState, useListBack } from './adminHooks'
import { agentChoices, siteChoices } from './adminModel'
import {
  DEVICE_FIELDS,
  DEVICE_LIMITS,
  DEVICE_TYPES,
  NEW_DEVICE,
  TYPE_LABEL,
  VERSIONS,
  VERSION_LABEL,
  deviceDraft,
  deviceInput,
  devicePatch,
  validateDevice,
  type DeviceDraft,
} from './devicesModel'
import { deviceEditorPath, snmpDevicePath } from './sections'

const AGENT_CHOICES = 200

interface EditorProps {
  device?: InventoryDevice
  scope: ScopeOptions
  agents: readonly AgentOption[]
  onSaved: (detail: InventoryDeviceDetail) => void
  onCreated: (detail: InventoryDeviceDetail) => void
}

/**
 * The form of a device: what it is and where, which agent polls it, and how (the SNMP block). The
 * credential profile is typed to set it and never shown: a blank field keeps the one the device has.
 */
function Editor({ device, scope, agents, onSaved, onCreated }: EditorProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState<DeviceDraft>(() => (device ? deviceDraft(device) : NEW_DEVICE))
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(DEVICE_FIELDS, shell?.announce, summary)
  const taken =
    form.failure?.code === 'device_exists' && form.failure.message ? [form.failure.message] : null
  const errors = { ...form.errors, ...(taken ? { name: taken } : {}) }
  const lines = taken ? [] : form.lines
  const hadSnmp = device?.snmp !== null && device?.snmp !== undefined
  const changed = device ? devicePatch(draft, device) !== null : true
  const locked = form.saving

  const edit = (changes: Partial<DeviceDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    form.touched()
  }

  const submit = () =>
    form.submit(
      validateDevice(draft, hadSnmp),
      async () => {
        if (device) {
          const body = devicePatch(draft, device)
          if (body === null) return
          onSaved(await api.updateInventoryDevice(device.id, body))
          setDraft((current) => ({ ...current, credentialProfile: '' }))
          shell?.announce('Device saved.')
        } else {
          onCreated(await api.createInventoryDevice(deviceInput(draft)))
          shell?.announce('Device created.')
        }
      },
      { failed: 'The device was not saved.' },
    )

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      aria-busy={locked}
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault()
        if (!locked) void submit()
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
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false, required: true }}
          hint={`Unique within its site, in any case; up to ${DEVICE_LIMITS.name} characters.`}
        />
        <FieldInput
          label="Management address"
          value={draft.address}
          onChange={(address) => edit({ address })}
          error={errors.address}
          input={{ disabled: locked, autoComplete: 'off', spellCheck: false, required: true }}
          hint="A host name or a unicast IP address the agent polls."
        />
        <FieldSelect
          label="Type"
          value={draft.type}
          onChange={(type: DeviceType) => edit({ type })}
          options={DEVICE_TYPES.map((type) => ({ value: type, label: TYPE_LABEL[type] }))}
          error={errors.type}
          disabled={locked}
        />
        <FieldSelect
          label="Site"
          value={draft.siteId}
          onChange={(siteId) => edit({ siteId })}
          options={siteChoices(scope, 'No site (seen by accounts with every customer only)')}
          error={errors.siteId}
          disabled={locked}
          hint="Decides who sees the device: the accounts granted the site or its customer."
        />
        <FieldSelect
          label="Agent"
          value={draft.agentId}
          onChange={(agentId) => edit({ agentId })}
          options={agentChoices(agents)}
          error={errors.agentId}
          disabled={locked}
          hint="The server whose agent polls it. The agent needs the SNMP extra and the credentials file."
        />
        <FieldTextArea
          label="Description"
          value={draft.description}
          onChange={(description) => edit({ description })}
          error={errors.description}
          textarea={{ disabled: locked, rows: 2 }}
          hint="Optional."
        />
        <Checkbox
          label="Enabled"
          description="A disabled device is polled by nobody and reads as idle."
          checked={draft.enabled}
          onChange={(enabled) => edit({ enabled })}
          disabled={locked}
          error={errors.enabled}
        />
      </div>

      <fieldset
        className="flex flex-col gap-4 rounded-sm border border-border p-3"
        disabled={locked}
      >
        <legend className="type-label px-1 text-fg-muted">SNMP</legend>
        <Checkbox
          label="Polled by SNMP"
          description="Off: the device is in the inventory but not polled; its history, if any, stays."
          checked={draft.snmp}
          onChange={(snmp) => edit({ snmp })}
          disabled={locked}
          error={errors.snmp}
        />
        {draft.snmp ? (
          <div className="grid gap-4 md:grid-cols-2">
            <FieldSelect
              label="Version"
              value={draft.version}
              onChange={(version: SnmpVersion) => edit({ version })}
              options={VERSIONS.map((version) => ({
                value: version,
                label: VERSION_LABEL[version],
              }))}
              error={errors['snmp.version']}
              disabled={locked}
            />
            <FieldInput
              label="Port"
              value={draft.port}
              onChange={(port) => edit({ port })}
              error={errors['snmp.port']}
              input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
              hint="161 unless the device says otherwise."
            />
            <FieldInput
              label="Credential profile"
              value={draft.credentialProfile}
              onChange={(credentialProfile) => edit({ credentialProfile })}
              error={errors['snmp.credentialProfile']}
              input={{
                disabled: locked,
                autoComplete: 'off',
                spellCheck: false,
                required: !hadSnmp,
              }}
              hint={
                hadSnmp
                  ? 'The name of a profile in the agent’s credentials file. The device has one, which is never shown: leave blank to keep it, or type another.'
                  : 'The name of a profile in the agent’s credentials file (letters, digits, . _ -). The credentials themselves never reach the server.'
              }
            />
            <FieldInput
              label="Poll interval (seconds)"
              value={draft.pollIntervalSeconds}
              onChange={(pollIntervalSeconds) => edit({ pollIntervalSeconds })}
              error={errors['snmp.pollIntervalSeconds']}
              input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
              hint={`${DEVICE_LIMITS.interval[0]} to ${DEVICE_LIMITS.interval[1]}.`}
            />
            <FieldInput
              label="Timeout (seconds)"
              value={draft.timeoutSeconds}
              onChange={(timeoutSeconds) => edit({ timeoutSeconds })}
              error={errors['snmp.timeoutSeconds']}
              input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
              hint={`Per request: ${DEVICE_LIMITS.timeout[0]} to ${DEVICE_LIMITS.timeout[1]}.`}
            />
            <FieldInput
              label="Retries"
              value={draft.retries}
              onChange={(retries) => edit({ retries })}
              error={errors['snmp.retries']}
              input={{ disabled: locked, inputMode: 'numeric', autoComplete: 'off' }}
              hint={`After a timeout: ${DEVICE_LIMITS.retries[0]} to ${DEVICE_LIMITS.retries[1]}. Timeout × (retries + 1) must stay under the interval.`}
            />
            {errors['snmp.nonField'] ? (
              <p role="alert" className={cn('type-body md:col-span-2', STATUS_TEXT.critical)}>
                {errors['snmp.nonField'].join(' ')}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={locked || !changed} aria-busy={locked}>
          {locked ? 'Saving…' : device ? 'Save changes' : 'Create device'}
        </Button>
        {device && !changed ? (
          <span className="type-body text-fg-muted">Nothing changed yet.</span>
        ) : null}
      </div>
    </form>
  )
}

/**
 * Settings > Devices > one device, or a new one: the form with its SNMP block, and its deletion,
 * refused by the server while SNMP history exists for it (disable it, and delete it once the
 * history has been purged by `purge_snmp_data`).
 */
export default function DeviceEditorPage() {
  const api = useApi()
  const { id } = useParams()
  const creating = id === undefined
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const view = useViewSearch()
  const shell = useContext(ShellContext)
  const { capabilities } = useAuth()
  const may = capabilities.manageDevices
  const back = useListBack('/settings/devices', view)
  const arrival = useArrivalState<{ created?: boolean }>()

  const detail = useResource(`inventory-device:${id ?? 'new'}:${may}`, async (signal) =>
    may && id !== undefined ? api.getInventoryDevice(id, { signal }) : null,
  )
  const scope = useResource<ScopeOptions | null>(`device-scope:${may}`, async (signal) =>
    may ? api.getScopeOptions({ signal }) : null,
  )
  const agents = useResource(`device-agents:${may}`, async (signal) =>
    may ? api.listAgents({ pageSize: AGENT_CHOICES, signal }) : null,
  )
  const [saved, setSaved] = useState<{
    at: string | undefined
    detail: InventoryDeviceDetail
  } | null>(null)
  if (saved !== null && saved.at !== id) setSaved(null)
  const current = saved !== null && saved.at === id ? saved.detail : (detail.data ?? undefined)
  const device = current?.item

  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  if (!may) {
    return (
      <NotPermitted
        what="change devices"
        hint="The console offers this only to an account that may change alert rules and holds the admin's permissions on devices and their SNMP configuration, with access to every customer. The server checks it on every request."
      />
    )
  }

  const notFound =
    detail.error instanceof ApiError && detail.error.status === 404 && current === undefined
  const loading = scope.data == null || agents.data == null || (!creating && device === undefined)
  const failed = scope.error ?? agents.error ?? detail.error
  const reload = () => {
    scope.refetch()
    agents.refetch()
    detail.refetch()
  }

  const remove = async () => {
    if (!device) return
    setDeleting(true)
    setProblem(null)
    try {
      const gone = await api.deleteInventoryDevice(device.id)
      shell?.announce(`Device “${gone.deleted.name}” deleted.`)
      void navigate(viewTo('/settings/devices'), {
        replace: true,
        state: { deleted: gone.deleted.name },
      })
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : 'The device could not be deleted: the server could not be reached.',
      )
      shell?.announce('The device was not deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <BackLink to={back}>Devices</BackLink>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="type-title">
            {creating ? (
              'New device'
            ) : device ? (
              device.name
            ) : failed ? (
              'Device'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h2>
          {device ? (
            <>
              <StatusTag
                status={device.enabled ? 'healthy' : 'idle'}
                word={device.enabled ? 'ENABLED' : 'DISABLED'}
                variant="tag"
              />
              {device.snmp ? (
                <Link
                  to={viewTo(snmpDevicePath(device.id))}
                  className="type-data text-primary underline underline-offset-2"
                >
                  Open in SNMP
                </Link>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      {arrival.created && !saved ? (
        <Notice status="healthy" word="CREATED" live="status">
          The device is created. The agent that polls it needs the credential profile in its own
          credentials file.
        </Notice>
      ) : null}
      {saved ? (
        <Notice status="healthy" word="SAVED" live="status">
          The device is saved.
        </Notice>
      ) : null}

      {notFound ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState title="Device not found" hint="It does not exist, or it was deleted." />
        </div>
      ) : (
        <Panel
          title="Device"
          features="settings"
          scope="NOW"
          status={loading ? (failed ? 'error' : 'loading') : 'success'}
          error={loading ? failed : null}
          onRetry={reload}
          skeleton={<div className="h-64" />}
          className="max-w-4xl"
        >
          {scope.data && agents.data && (creating || device) ? (
            <Editor
              key={device ? `${device.id}:${current?.generatedAt ?? ''}` : 'new'}
              device={device}
              scope={scope.data}
              agents={agents.data.items}
              onSaved={(next) => setSaved({ at: id, detail: next })}
              onCreated={(next) =>
                void navigate(viewTo(deviceEditorPath(next.item.id)), {
                  state: { created: true, list: back.search },
                })
              }
            />
          ) : null}
        </Panel>
      )}

      {device ? (
        <Panel title="Delete" features="settings" scope="NOW" className="max-w-4xl">
          {confirm ? (
            <DeleteConfirm
              kind="device"
              name={device.name}
              busy={deleting}
              problem={problem}
              onConfirm={() => void remove()}
              onCancel={() => setConfirm(false)}
            >
              <p>The device goes with its SNMP settings, its latest state and its interfaces.</p>
              <p>The server refuses while polls or interface samples exist for it.</p>
            </DeleteConfirm>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => setConfirm(true)}
                disabled={device.hasHistory}
                aria-describedby={device.hasHistory ? 'device-history' : undefined}
              >
                Delete device
              </Button>
              <span id="device-history" className="type-body text-fg-muted">
                {device.hasHistory
                  ? 'SNMP history exists for it: disable the device, and delete it after the history has been purged (manage.py purge_snmp_data).'
                  : 'No SNMP history: it can be deleted now. To stop polling it for a while, disable it instead.'}
              </span>
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  )
}
