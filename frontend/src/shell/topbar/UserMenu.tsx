import { User } from 'lucide-react'
import { useOptionalAuth } from '@/app/auth/auth'
import { Menu } from '@/ui/controls'

/** Who is signed in, and the way out. Absent when there is no sign-in (mock mode). */
export function UserMenu({ iconOnly = false }: { iconOnly?: boolean }) {
  const auth = useOptionalAuth()
  const user = auth?.user
  if (!auth || !user) return null
  return (
    <Menu
      label={`Account ${user.username}`}
      trigger={
        <>
          <User size={16} strokeWidth={1.5} aria-hidden="true" />
          {iconOnly ? null : (
            <span className="type-tag hidden max-w-28 truncate 2xl:inline">{user.username}</span>
          )}
        </>
      }
      items={[
        {
          type: 'action',
          label: 'Sign out',
          // Signed out, the route guard takes this tab to the sign-in page.
          onSelect: () => void auth.signOut(),
        },
      ]}
    />
  )
}
