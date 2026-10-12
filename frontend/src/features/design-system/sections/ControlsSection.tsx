import { ButtonSpecimens } from './ButtonSpecimens'
import { ChoiceSpecimens } from './ChoiceSpecimens'
import { OverlaySpecimens } from './OverlaySpecimens'

export function ControlsSection() {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <ButtonSpecimens />
      <ChoiceSpecimens />
      <OverlaySpecimens />
    </div>
  )
}
