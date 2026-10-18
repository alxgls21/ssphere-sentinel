import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Notice } from './Notice'

describe('Notice', () => {
  it('says its word and its sentence, so the colour is never alone', () => {
    render(
      <Notice status="critical" word="NOT SAVED">
        The name is taken.
      </Notice>,
    )
    expect(screen.getByText('NOT SAVED')).toBeInTheDocument()
    expect(screen.getByText('The name is taken.')).toBeInTheDocument()
  })

  it('is an alert for what went wrong now', () => {
    render(
      <Notice status="critical" word="NOT SAVED" live="alert">
        Failed.
      </Notice>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Failed.')
  })

  it('is a status, politely announced, for what happened', () => {
    render(
      <Notice status="healthy" word="SAVED" live="status">
        Saved.
      </Notice>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is announced as neither when it is simply so', () => {
    render(
      <Notice status="warning" word="NOTE">
        Just so.
      </Notice>,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers its actions, and they work', async () => {
    const onRetry = vi.fn()
    render(
      <Notice status="warning" word="CHANGED" actions={<button onClick={onRetry}>Reload</button>}>
        Changed elsewhere.
      </Notice>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
