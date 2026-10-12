/**
 * Copies text. navigator.clipboard exists only in secure contexts, and a
 * self-hosted console is often served over plain HTTP on a LAN, so the
 * fallback (a selected, off-screen textarea) is a normal path here.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyWithSelection(text)
  }
}

function copyWithSelection(text: string): boolean {
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.setAttribute('aria-hidden', 'true')
  field.style.position = 'fixed'
  field.style.top = '0'
  field.style.opacity = '0'
  // Selecting moves focus; give it back so the operator keeps their place in the queue.
  const previous = document.activeElement
  document.body.append(field)
  field.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    if (previous instanceof HTMLElement) previous.focus()
  }
}
