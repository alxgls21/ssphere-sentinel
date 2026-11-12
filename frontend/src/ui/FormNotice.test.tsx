import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormNotice } from './FormNotice'

describe('FormNotice', () => {
  it('names the fields that are wrong and the server’s lines in one alert', () => {
    render(<FormNotice invalid={['name', 'port']} lines={['It no longer exists.']} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('NOT SAVED')
    expect(alert).toHaveTextContent(
      'Some values are not valid: name, port. Each is explained under its field.',
    )
    expect(alert).toHaveTextContent('It no longer exists.')
  })

  it('shows what it is given instead when nothing went wrong, with its own word', () => {
    render(
      <FormNotice invalid={[]} lines={[]} word="NOT ADDED">
        <p>All done.</p>
      </FormNotice>,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('All done.')).toBeInTheDocument()
  })
})
