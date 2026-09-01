import { AuthProvider } from './auth/AuthProvider.tsx'
import { clientConfiguration } from './config.ts'
import App from './App.tsx'

function ConfigurationError({ message }: { message: string }) {
  return (
    <main className="setup-page">
      <section className="setup-terminal" aria-labelledby="setup-error-title">
        <header className="setup-terminal__head">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">pb</span>
            <span>perfectly-balanced</span>
          </span>
          <span className="spent">configuration error</span>
        </header>
        <div className="setup-terminal__body">
          <p className="eyebrow">Environment required</p>
          <h1 id="setup-error-title">The workspace cannot start yet.</h1>
          <p>
            Copy <code>.env.example</code> to <code>.env</code>, then provide
            the required local environment values.
          </p>
          <div className="config-command">
            <span aria-hidden="true">$</span>
            <code>cp .env.example .env</code>
          </div>
          <p className="config-error">{message}</p>
        </div>
      </section>
    </main>
  )
}

function Root() {
  const { config, error } = clientConfiguration

  if (!config) {
    return (
      <ConfigurationError
        message={error ?? 'The application environment is invalid.'}
      />
    )
  }

  return (
    <AuthProvider>
      <App appName={config.appName} />
    </AuthProvider>
  )
}

export default Root
