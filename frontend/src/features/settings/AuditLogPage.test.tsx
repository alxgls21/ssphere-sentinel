import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import AuditLogPage from './AuditLogPage'
import { auditEntry, auditLog } from './adminTesting'
import { can } from './testing'

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{pathname + search}</span>
}

function setup({
  capabilities = can('viewAuditLog'),
  listAuditLog = vi.fn<SentinelApi['listAuditLog']>(async () =>
    auditLog([
      auditEntry(),
      auditEntry({
        id: 41,
        actor: { id: null, username: 'former' },
        action: 'user_created',
        actionLabel: 'User created',
        targetType: 'user',
        targetTypeLabel: 'User',
        targetId: '7',
        targetName: 'maria',
        changes: {
          role: { before: null, after: 'viewer' },
          customerIds: { before: null, after: ['c1'] },
        },
      }),
    ]),
  ),
} = {}) {
  const api = createTestApi({ source: 'http', listAuditLog })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/audit-log" element={<AuditLogPage />} />
      </Routes>
      <Where />
    </>,
    { api, route: '/settings/audit-log', auth: createFakeAuth({ capabilities }) },
  )
  return { listAuditLog }
}

const table = () => screen.findByRole('table', { name: 'Audit log' })

describe('Audit log', () => {
  it('says so without the capability, and asks for nothing', () => {
    const { listAuditLog } = setup({ capabilities: can('manageUsers') })
    expect(screen.getByText('Not permitted to see the audit log')).toBeInTheDocument()
    expect(listAuditLog).not.toHaveBeenCalled()
  })

  it('lists who did what to which object, with the fields that changed in words', async () => {
    setup()
    const rows = within(await table())
      .getAllByRole('row')
      .slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('admin')
    expect(rows[0]).toHaveTextContent('Customer changed')
    expect(rows[0]).toHaveTextContent('Customer Meridian')
    expect(rows[0]).toHaveTextContent('notes:')
    expect(rows[0]).toHaveTextContent('blank')
    expect(rows[0]).toHaveTextContent('first customer')
    expect(rows[1]).toHaveTextContent('former')
    expect(rows[1]).toHaveTextContent('(gone)')
    // The arrow is read as "to" by a screen reader, which the text content shows.
    expect(rows[1]).toHaveTextContent(/role:\s*none\s*→\s*to\s*viewer/)
    expect(rows[1]).toHaveTextContent(/customerIds:\s*none\s*→\s*to\s*c1/)
    expect(screen.getByText('2 of 2 shown')).toBeInTheDocument()
  })

  it('offers the actions and the objects the server knows as filters, kept in the URL', async () => {
    const user = userEvent.setup()
    const { listAuditLog } = setup()
    await table()
    expect(
      within(screen.getByLabelText('Action'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Any action', 'Customer changed', 'User created'])
    await user.selectOptions(screen.getByLabelText('Action'), 'user_created')
    await waitFor(() =>
      expect(listAuditLog).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'user_created' }),
      ),
    )
    await user.selectOptions(screen.getByLabelText('Object'), 'user')
    await waitFor(() =>
      expect(listAuditLog).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'user_created', targetType: 'user' }),
      ),
    )
    expect(screen.getByTestId('where').textContent).toBe(
      '/settings/audit-log?action=user_created&targetType=user',
    )
    await user.type(screen.getByLabelText('Search the audit log'), 'maria')
    await waitFor(() =>
      expect(listAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'maria' })),
    )
  })

  it('says when nothing was recorded yet', async () => {
    setup({ listAuditLog: vi.fn(async () => auditLog([], 0)) })
    expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument()
  })
})
