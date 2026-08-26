import { AuthProvider } from './auth/AuthProvider.tsx'
import { clientConfiguration } from './config.ts'
import App from './App.tsx'

function ConfigurationError({ message }: { message: string }) {
  return (
    <main className="configuration-error">
      <div className="configuration-error__panel">
        <p className="eyebrow">Configuration required</p>
        <h1>Set up your local environment</h1>
        <p>
          Copy <code>.env.example</code> to <code>.env</code>, then provide the
          required Vite environment variables before starting the app.
        </p>
        <p className="configuration-error__message">{message}</p>
      </div>
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
