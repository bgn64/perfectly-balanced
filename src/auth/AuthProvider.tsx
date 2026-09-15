import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { getSupabaseClient } from '../lib/supabase.ts'
import { AuthContext, type AuthContextValue } from './authContext.ts'
import { loadSessionWithJwtRecovery } from './jwtRecovery.ts'

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = getSupabaseClient()
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [initializationError, setInitializationError] = useState<string | null>(
    null,
  )

  useEffect(() => {
    let isMounted = true
    let sessionRevision = 0

    function setAuthenticatedSession(nextSession: Session | null) {
      if (!isMounted) {
        return
      }

      setSession(nextSession)
      setUser(nextSession?.user ?? null)
      setInitializationError(null)
      setIsLoading(false)
    }

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, nextSession) => {
      if (event !== 'INITIAL_SESSION') sessionRevision += 1
      setAuthenticatedSession(nextSession)
    })

    const initializationRevision = sessionRevision
    void loadSessionWithJwtRecovery(client.auth).then(({ data, error }) => {
      if (!isMounted || sessionRevision !== initializationRevision) {
        return
      }

      if (error) {
        setInitializationError(error.message)
        setIsLoading(false)
        return
      }

      setAuthenticatedSession(data.session)
    }).catch((error: unknown) => {
      if (!isMounted || sessionRevision !== initializationRevision) return
      setInitializationError(error instanceof Error ? error.message : 'Session initialization failed.')
      setIsLoading(false)
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [client])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      isLoading,
      initializationError,
      async signOut() {
        const { error } = await client.auth.signOut()

        if (error) {
          throw error
        }
      },
    }),
    [client, initializationError, isLoading, session, user],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
