import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
} from 'npm:plaid@46.0.0'

interface PlaidConfigurationValues {
  clientId: string
  secret: string
  clientName: string
  countryCodes: CountryCode[]
  redirectUri: string
  webhookUrl: string
}

function requiredEnvironmentValue(name: string): string {
  const value = Deno.env.get(name)?.trim()

  if (!value) {
    throw new Error(`Missing required function environment variable: ${name}.`)
  }

  return value
}

function isCountryCode(value: string): value is CountryCode {
  return Object.values(CountryCode).some((countryCode) => countryCode === value)
}

function countryCodes(): CountryCode[] {
  const values = requiredEnvironmentValue('PLAID_COUNTRY_CODES')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)

  if (values.length === 0 || !values.every(isCountryCode)) {
    throw new Error('PLAID_COUNTRY_CODES must contain valid Plaid country codes.')
  }

  return values
}

function requiredHttpsUrl(name: string): string {
  const value = requiredEnvironmentValue(name)

  try {
    const url = new URL(value)

    if (url.protocol !== 'https:' || url.search || url.hash) {
      throw new Error()
    }
  } catch {
    throw new Error(`${name} must be an HTTPS URL without a query or fragment.`)
  }

  return value
}

export function getPlaidConfiguration(): PlaidConfigurationValues {
  const environment = requiredEnvironmentValue('PLAID_ENVIRONMENT')

  if (environment !== 'production') {
    throw new Error('PLAID_ENVIRONMENT must be production for this live integration.')
  }

  return {
    clientId: requiredEnvironmentValue('PLAID_CLIENT_ID'),
    secret: requiredEnvironmentValue('PLAID_SECRET'),
    clientName: requiredEnvironmentValue('PLAID_CLIENT_NAME'),
    countryCodes: countryCodes(),
    redirectUri: requiredHttpsUrl('PLAID_REDIRECT_URI'),
    webhookUrl: requiredHttpsUrl('PLAID_WEBHOOK_URL'),
  }
}

export function getPlaidClient(configuration = getPlaidConfiguration()): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments.production,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': configuration.clientId,
          'PLAID-SECRET': configuration.secret,
        },
      },
    }),
  )
}
