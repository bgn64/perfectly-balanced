import { useState, type FormEvent } from 'react'
import { useAuth } from './auth/useAuth.ts'
import { CategoriesPanel } from './categories/CategoriesPanel.tsx'
import { getClientConfiguration } from './config.ts'
import { getSupabaseClient } from './lib/supabase.ts'
import { TransactionsPanel } from './transactions/TransactionsPanel.tsx'
import './App.css'

interface AppProps {
  appName: string
}

function App({ appName }: AppProps) {
  const { isLoading, initializationError, session, user } = useAuth()

  if (isLoading) {
    return <LoadingScreen appName={appName} />
  }

  if (initializationError) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="auth-error-title">
          <p className="eyebrow">{appName}</p>
          <h1 id="auth-error-title">We could not verify your session</h1>
          <p className="auth-card__copy">{initializationError}</p>
          <p className="auth-card__hint">Refresh the page to try again.</p>
        </section>
      </main>
    )
  }

  if (!session || !user) {
    return <SignInScreen appName={appName} />
  }

  return (
    <AuthenticatedShell
      appName={appName}
      email={user.email ?? ''}
    />
  )
}

function LoadingScreen({ appName }: AppProps) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-live="polite">
        <p className="eyebrow">{appName}</p>
        <h1>Checking your session</h1>
        <p className="auth-card__copy">One moment while we securely sign you in.</p>
      </section>
    </main>
  )
}

function SignInScreen({ appName }: AppProps) {
  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedEmail = email.trim()
    if (!normalizedEmail) {
      setErrorMessage('Enter your email address to receive a sign-in link.')
      return
    }

    setIsSubmitting(true)
    setErrorMessage(null)
    setSuccessMessage(null)

    const { error } = await getSupabaseClient().auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: getClientConfiguration().siteUrl,
        shouldCreateUser: false,
      },
    })

    setIsSubmitting(false)

    if (error) {
      setErrorMessage(error.message)
      return
    }

    setSuccessMessage(`We sent a secure sign-in link to ${normalizedEmail}.`)
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <p className="eyebrow">{appName}</p>
        <h1 id="sign-in-title">Sign in with email</h1>
        <p className="auth-card__copy">
          Enter the email address associated with your invitation. We will send
          you a one-time sign-in link.
        </p>
        <form className="sign-in-form" onSubmit={handleSubmit}>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={isSubmitting}
            required
          />
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Sending sign-in link...' : 'Email me a sign-in link'}
          </button>
        </form>
        {errorMessage && (
          <p className="form-message form-message--error" role="alert">
            {errorMessage}
          </p>
        )}
        {successMessage && (
          <p className="form-message form-message--success" aria-live="polite">
            {successMessage}
          </p>
        )}
      </section>
    </main>
  )
}

function AuthenticatedShell({
  appName,
  email,
}: {
  appName: string
  email: string
}) {
  const { signOut } = useAuth()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [categoriesRevision, setCategoriesRevision] = useState(0)

  async function handleSignOut() {
    setIsSigningOut(true)
    setSignOutError(null)

    try {
      await signOut()
    } catch (error) {
      setSignOutError(
        error instanceof Error
          ? error.message
          : 'We could not sign you out. Please try again.',
      )
      setIsSigningOut(false)
    }
  }

  return (
    <main className="app-shell">
      <header className="app-shell__header">
        <div>
          <p className="eyebrow">{appName}</p>
          <h1>Welcome</h1>
        </div>
        <div className="app-shell__account">
          <span>{email}</span>
          <button
            className="button button--secondary"
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
          >
            {isSigningOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </header>
      <section className="app-shell__content" aria-labelledby="workspace-title">
        <p className="eyebrow">Protected workspace</p>
        <h2 id="workspace-title">You are signed in</h2>
        <p>
          This is the authenticated starting point for your application. Add
          product features here knowing that only invited users can reach them.
        </p>
        {signOutError && (
          <p className="form-message form-message--error" role="alert">
            {signOutError}
          </p>
        )}
      </section>
      <CategoriesPanel
        onCategoriesChanged={() => {
          setCategoriesRevision((revision) => revision + 1)
        }}
      />
      <TransactionsPanel categoriesRevision={categoriesRevision} />
    </main>
  )
}

export default App
