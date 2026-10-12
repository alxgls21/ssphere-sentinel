import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'execCommand')
  document.body.replaceChildren()
})

/** jsdom has no execCommand; the legacy path needs one, and a copy needs a selection to read. */
function stubExecCommand(result: boolean | Error) {
  const selected: string[] = []
  document.execCommand = vi.fn(() => {
    selected.push(document.querySelector('textarea')?.value ?? '')
    if (result instanceof Error) throw result
    return result
  })
  return selected
}

describe('copyText', () => {
  it('uses the async clipboard when there is one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyText('http://sentinel/?range=6h')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('http://sentinel/?range=6h')
  })

  it('selects a scratch field and copies when the async clipboard is missing (plain http)', async () => {
    vi.stubGlobal('navigator', {})
    const selected = stubExecCommand(true)
    await expect(copyText('http://sentinel/')).resolves.toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(selected).toEqual(['http://sentinel/'])
  })

  it('falls back when the async clipboard refuses', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('denied')) },
    })
    stubExecCommand(true)
    await expect(copyText('x')).resolves.toBe(true)
    expect(document.execCommand).toHaveBeenCalled()
  })

  it('removes the scratch field, and reports failure, when the copy does not work', async () => {
    vi.stubGlobal('navigator', {})
    stubExecCommand(false)
    await expect(copyText('x')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports failure when the browser has no way to copy at all', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyText('x')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('reports failure when copying throws', async () => {
    vi.stubGlobal('navigator', {})
    stubExecCommand(new Error('blocked'))
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('puts the scratch field inside the dialog that holds focus, which is the only place a modal allows it', async () => {
    vi.stubGlobal('navigator', {})
    const dialog = document.createElement('dialog')
    const input = document.createElement('input')
    dialog.append(input)
    dialog.setAttribute('open', '')
    document.body.append(dialog)
    input.focus()
    let host: Element | null | undefined
    document.execCommand = vi.fn(() => {
      host = document.querySelector('textarea')?.parentElement
      return true
    })
    await copyText('x')
    expect(host).toBe(dialog)
  })
})
