import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { SearchField } from './SearchField'

function Harness() {
  const [value, setValue] = useState('')
  return <SearchField label="Search servers" value={value} onChange={setValue} />
}

describe('SearchField', () => {
  it('is a native search box named by its label', () => {
    render(<Harness />)
    expect(screen.getByRole('searchbox', { name: 'Search servers' })).toHaveAttribute(
      'placeholder',
      'Search servers',
    )
  })

  it('reports every keystroke', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.type(screen.getByRole('searchbox'), 'ath')
    expect(screen.getByRole('searchbox')).toHaveValue('ath')
  })

  it('offers a clear button only while there is text, and keeps focus on the box', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    await user.type(screen.getByRole('searchbox'), 'ath')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('searchbox')).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })
})
