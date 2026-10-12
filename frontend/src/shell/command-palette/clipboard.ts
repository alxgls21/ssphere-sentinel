/**
 * Copies text and reports whether it worked. The async Clipboard API only
 * exists in secure contexts, and a self-hosted console is often served over
 * plain http on a LAN, so there is a legacy path for exactly that case.
 *
 * Call it synchronously from the user's action: both paths need the gesture.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or the document lost focus: the legacy path may still work.
    }
  }
  return copyWithSelection(text)
}

function copyWithSelection(text: string): boolean {
  // A modal dialog makes everything outside it inert, and an inert field cannot be selected,
  // so the scratch field goes inside whichever dialog holds focus.
  const host = document.activeElement?.closest('dialog') ?? document.body
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.setAttribute('aria-hidden', 'true')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  host.append(field)
  field.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
  }
}
