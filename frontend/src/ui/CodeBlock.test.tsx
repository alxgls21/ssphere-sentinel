import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeBlock } from './CodeBlock'

afterEach(() => vi.unstubAllGlobals())

describe('CodeBlock', () => {
  it('shows the text verbatim under its heading, with a note and a copy button that names what it copies', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(
      <CodeBlock title="Entry for this target" what="Entry" text={'{\n  "id": "t1"\n}'}>
        Goes into the targets file.
      </CodeBlock>,
    )
    expect(screen.getByRole('region', { name: 'Entry for this target' })).toBeInTheDocument()
    expect(screen.getByLabelText('Entry text')).toHaveTextContent('"id": "t1"')
    expect(screen.getByText('Goes into the targets file.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy entry' }))
    expect(writeText).toHaveBeenCalledWith('{\n  "id": "t1"\n}')
    expect(await screen.findByRole('button', { name: 'Entry copied' })).toBeInTheDocument()
  })
})
