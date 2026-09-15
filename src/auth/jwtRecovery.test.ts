import { describe, expect, it, vi } from 'vitest'
import { AuthApiError, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { createJwtRecoveryFetch, createSessionRecovery, loadSessionWithJwtRecovery } from './jwtRecovery.ts'

const baseUrl = 'http://localhost:54321'
const rejected = () => Response.json({ message: 'JWT issued at future', code: 'PGRST301' }, { status: 401 })

function authFixture() {
  let session: Session | null = {
    access_token: 'old', refresh_token: 'refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: 'user', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
  }
  const auth = {
    getSession: vi.fn<SupabaseClient['auth']['getSession']>().mockImplementation(async () =>
      session ? { data: { session }, error: null } : { data: { session: null }, error: null },
    ),
    refreshSession: vi.fn<SupabaseClient['auth']['refreshSession']>().mockImplementation(async () => {
      session = session ? { ...session, access_token: 'new' } : null
      return session ? { data: { session, user: session.user }, error: null }
        : { data: { session: null, user: null }, error: null }
    }),
  }
  return { auth, setSession: (next: Session | null) => { session = next }, session }
}

describe('session recovery coordination', () => {
  it('coalesces concurrent and late rejections of the same token', async () => {
    const { auth } = authFixture()
    const recover = createSessionRecovery(auth)
    expect(await Promise.all([recover('Bearer old'), recover('Bearer old')])).toEqual(['new', 'new'])
    expect(await recover('Bearer old')).toBe('new')
    expect(auth.refreshSession).toHaveBeenCalledOnce()
  })

  it('does not refresh anonymous or custom authorization requests', async () => {
    const { auth, setSession } = authFixture()
    const recover = createSessionRecovery(auth)
    expect(await recover('Bearer custom')).toBeNull()
    setSession(null)
    expect(await recover('Bearer old')).toBeNull()
    expect(auth.refreshSession).not.toHaveBeenCalled()
  })

  it('does not replay after sign-out or an account switch', async () => {
    const fixture = authFixture()
    fixture.auth.refreshSession.mockImplementationOnce(async () => {
      const refreshed = { ...fixture.session!, access_token: 'new' }
      fixture.setSession(null)
      return { data: { session: refreshed, user: refreshed.user }, error: null }
    })
    const recover = createSessionRecovery(fixture.auth)
    expect(await recover('Bearer old')).toBeNull()
    fixture.setSession({ ...fixture.session!, access_token: 'new', user: { ...fixture.session!.user, id: 'other-user' } })
    expect(await recover('Bearer old')).toBeNull()
    expect(fixture.auth.refreshSession).toHaveBeenCalledOnce()
  })
})

describe('future-issued JWT read recovery', () => {
  it('refreshes once and retries the read with the new token', async () => {
    const fetchRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(Response.json([{ id: 'transaction' }]))
    const recover = vi.fn().mockResolvedValue('fresh-token')
    const request = createJwtRecoveryFetch(baseUrl, recover, fetchRequest)
    const response = await request(`${baseUrl}/rest/v1/transactions`, {
      headers: { Authorization: 'Bearer old-token', apikey: 'public-key' },
    })
    expect(response.status).toBe(200)
    expect(recover).toHaveBeenCalledExactlyOnceWith('Bearer old-token')
    const headers = new Headers(fetchRequest.mock.calls[1][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer fresh-token')
    expect(headers.get('apikey')).toBe('public-key')
    expect(fetchRequest).toHaveBeenCalledTimes(2)
  })

  it('never loops if the refreshed token is also rejected', async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async () => rejected())
    const recover = vi.fn().mockResolvedValue('fresh-token')
    const request = createJwtRecoveryFetch(baseUrl, recover, fetchRequest)
    const response = await request(`${baseUrl}/rest/v1/transactions`, { headers: { Authorization: 'Bearer old' } })
    expect(await response.json()).toMatchObject({ message: 'JWT issued at future' })
    expect(fetchRequest).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledOnce()
  })

  it.each([
    ['POST', `${baseUrl}/rest/v1/rpc/update_budget`],
    ['PATCH', `${baseUrl}/rest/v1/transactions`],
    ['GET', `${baseUrl}/auth/v1/user`],
    ['GET', 'https://other.example/rest/v1/transactions'],
  ])('does not replay %s %s', async (method, url) => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(rejected())
    const recover = vi.fn()
    const request = createJwtRecoveryFetch(baseUrl, recover, fetchRequest)
    await request(url, { method, headers: { Authorization: 'Bearer old' } })
    expect(fetchRequest).toHaveBeenCalledOnce()
    expect(recover).not.toHaveBeenCalled()
  })

  it('preserves unrelated errors and the original readable response', async () => {
    const original = Response.json({ message: 'JWT expired' }, { status: 401 })
    const recover = vi.fn()
    const request = createJwtRecoveryFetch(baseUrl, recover, vi.fn<typeof fetch>().mockResolvedValue(original))
    const response = await request(`${baseUrl}/rest/v1/transactions`)
    expect(await response.json()).toEqual({ message: 'JWT expired' })
    expect(recover).not.toHaveBeenCalled()
  })

  it('preserves the JWT error if recovery fails', async () => {
    const request = createJwtRecoveryFetch(baseUrl, async () => { throw new Error('Offline') }, async () => rejected())
    const response = await request(`${baseUrl}/rest/v1/transactions`, { headers: { Authorization: 'Bearer old' } })
    expect(await response.json()).toMatchObject({ message: 'JWT issued at future' })
  })

  it('does not refresh an aborted read', async () => {
    const controller = new AbortController()
    const recover = vi.fn()
    const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort()
      return rejected()
    })
    const request = createJwtRecoveryFetch(baseUrl, recover, fetchRequest)
    await request(`${baseUrl}/rest/v1/transactions`, {
      signal: controller.signal, headers: { Authorization: 'Bearer old' },
    })
    expect(recover).not.toHaveBeenCalled()
    expect(fetchRequest).toHaveBeenCalledOnce()
  })

  it('supports Request inputs and preserves their query and headers', async () => {
    const fetchRequest = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(Response.json([]))
    const request = createJwtRecoveryFetch(baseUrl, async () => 'new', fetchRequest)
    const input = new Request(`${baseUrl}/rest/v1/transactions?limit=20`, {
      headers: { Authorization: 'Bearer old', 'Range-Unit': 'items' },
    })
    expect((await request(input)).status).toBe(200)
    expect(fetchRequest.mock.calls[1][0]).toBe(input)
    expect(new Headers(fetchRequest.mock.calls[1][1]?.headers).get('Range-Unit')).toBe('items')
  })
})

describe('startup JWT recovery', () => {
  it('refreshes a failed future-issued session once', async () => {
    const fixture = authFixture()
    const auth = {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: new AuthApiError('JWT issued at future', 401, undefined) }),
      refreshSession: fixture.auth.refreshSession,
    }
    expect((await loadSessionWithJwtRecovery(auth)).data.session?.access_token).toBe('new')
    expect(auth.refreshSession).toHaveBeenCalledOnce()
  })

  it('keeps the original error when recovery fails and leaves other errors alone', async () => {
    const result = { data: { session: null }, error: new AuthApiError('JWT issued at future', 401, undefined) }
    const auth = {
      getSession: vi.fn().mockResolvedValue(result),
      refreshSession: vi.fn().mockRejectedValue(new Error('Offline')),
    }
    expect(await loadSessionWithJwtRecovery(auth)).toBe(result)
    result.error = new AuthApiError('Invalid credentials', 401, undefined)
    expect(await loadSessionWithJwtRecovery(auth)).toBe(result)
    expect(auth.refreshSession).toHaveBeenCalledOnce()
  })
})