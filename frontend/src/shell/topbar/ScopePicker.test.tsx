import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { ScopeOptions } from '@/api/types'
import { createTestApi, renderApp } from '@/test/render'
import { SCOPE_OPTIONS } from '../testing'
import { FiltersMenu } from './FiltersMenu'
import { ScopePicker } from './ScopePicker'
import { useScopeState } from './scope'

function Bar({ compact = false }: { compact?: boolean }) {
  const state = useScopeState()
  return compact ? <FiltersMenu state={state} /> : <ScopePicker state={state} />
}

const customer = () => screen.getByRole('combobox', { name: 'Customer' })
const site = () => screen.getByRole('combobox', { name: 'Site' })

function setup(getScopeOptions: () => Promise<ScopeOptions>, compact = false) {
  const spy = vi.fn(getScopeOptions)
  renderApp(<Bar compact={compact} />, { api: createTestApi({ getScopeOptions: spy }) })
  return spy
}

const unavailable = () => new ApiError('The server is unavailable (HTTP 502).', 502)

describe('ScopePicker', () => {
  it('offers the customers and sites the API returned, and nothing else', async () => {
    setup(async () => SCOPE_OPTIONS)
    await waitFor(() => expect(customer()).toBeEnabled())
    expect(Array.from((customer() as HTMLSelectElement).options).map((o) => o.text)).toEqual([
      'All customers',
      'Acme',
      'Globex',
    ])
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  describe('when the scope cannot be loaded', () => {
    it('keeps the selectors disabled, says why, and offers a retry', async () => {
      setup(() => Promise.reject(unavailable()))
      const button = await screen.findByRole('button', { name: /could not be loaded/i })
      expect(button).toHaveAccessibleName(/The server is unavailable \(HTTP 502\)/)
      expect(customer()).toBeDisabled()
      expect(site()).toBeDisabled()
    })

    it('does not substitute any other scope: only "All" is on offer', async () => {
      setup(() => Promise.reject(unavailable()))
      await screen.findByRole('button', { name: /could not be loaded/i })
      expect(Array.from((customer() as HTMLSelectElement).options).map((o) => o.text)).toEqual([
        'All customers',
      ])
    })

    it('asks again on retry and restores the selectors when it succeeds', async () => {
      const user = userEvent.setup()
      const spy = setup(
        vi
          .fn<() => Promise<ScopeOptions>>()
          .mockRejectedValueOnce(unavailable())
          .mockResolvedValue(SCOPE_OPTIONS),
      )
      await user.click(await screen.findByRole('button', { name: /could not be loaded/i }))
      await waitFor(() => expect(customer()).toBeEnabled())
      expect(site()).toBeEnabled()
      expect(spy).toHaveBeenCalledTimes(2)
      expect(Array.from((customer() as HTMLSelectElement).options).map((o) => o.text)).toContain(
        'Acme',
      )
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    })

    it('keeps the explanation and the retry when the retry fails too', async () => {
      const user = userEvent.setup()
      const spy = setup(() => Promise.reject(unavailable()))
      await user.click(await screen.findByRole('button', { name: /could not be loaded/i }))
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
      expect(await screen.findByRole('button', { name: /could not be loaded/i })).toBeVisible()
      expect(customer()).toBeDisabled()
    })

    it('shows the loading state, not the error, while the retry is in flight', async () => {
      const user = userEvent.setup()
      let release!: (options: ScopeOptions) => void
      setup(
        vi
          .fn<() => Promise<ScopeOptions>>()
          .mockRejectedValueOnce(unavailable())
          .mockImplementation(() => new Promise((resolve) => (release = resolve))),
      )
      await user.click(await screen.findByRole('button', { name: /could not be loaded/i }))
      await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).toBeNull())
      expect(customer()).toBeDisabled()
      release(SCOPE_OPTIONS)
      await waitFor(() => expect(customer()).toBeEnabled())
    })
  })
})

describe('FiltersMenu (the folded bar)', () => {
  it('offers the retry inside the menu when the scope could not be loaded', async () => {
    const user = userEvent.setup()
    const spy = setup(
      vi
        .fn<() => Promise<ScopeOptions>>()
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValue(SCOPE_OPTIONS),
      true,
    )
    await waitFor(() => expect(spy).toHaveBeenCalled())
    await user.click(await screen.findByRole('button', { name: /^Filters/ }))
    await user.click(await screen.findByRole('menuitem', { name: /could not be loaded.*retry/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: /^Filters/ }))
    expect(screen.queryByRole('menuitem', { name: /retry/i })).toBeNull()
    expect(await screen.findByRole('menuitemradio', { name: 'Acme' })).toBeInTheDocument()
  })
})
