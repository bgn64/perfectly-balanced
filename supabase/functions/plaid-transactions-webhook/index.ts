import {
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from 'npm:jose@6.2.9'
import { getPlaidClient } from '../_shared/plaid.ts'
import {
  jsonResponse,
  logExternalServiceError,
} from '../_shared/http.ts'
import { getServiceRoleClient } from '../_shared/supabase.ts'
import { syncPlaidItem } from '../_shared/transactionSync.ts'

interface PlaidWebhook {
  item_id: string
  webhook_type: string
  webhook_code: string
  account_id?: string
  initial_update_complete?: boolean
  historical_update_complete?: boolean
  error?: {
    error_code?: string
  }
}

function isPlaidWebhook(value: unknown): value is PlaidWebhook {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const webhook = value as Record<string, unknown>
  return (
    typeof webhook.item_id === 'string' &&
    typeof webhook.webhook_type === 'string' &&
    typeof webhook.webhook_code === 'string'
  )
}

function hexDigest(body: string): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(body))
    .then((digest) =>
      [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    )
}

function timingSafeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) {
    return false
  }

  let difference = 0

  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index)
  }

  return difference === 0
}

async function verifyWebhook(
  request: Request,
  rawBody: string,
): Promise<string> {
  const signature = request.headers.get('plaid-verification')

  if (!signature) {
    throw new Error('Plaid webhook signature is missing.')
  }

  const header = decodeProtectedHeader(signature)

  if (header.alg !== 'ES256' || typeof header.kid !== 'string') {
    throw new Error('Plaid webhook signature uses an unsupported algorithm.')
  }

  const key = await getPlaidClient().webhookVerificationKeyGet({
    key_id: header.kid,
  })
  const verificationKey = await importJWK(key.data.key, 'ES256')
  const { payload } = await jwtVerify(signature, verificationKey, {
    algorithms: ['ES256'],
  })
  const issuedAt = payload.iat
  const expectedDigest = payload.request_body_sha256

  if (
    typeof issuedAt !== 'number' ||
    Math.abs(Date.now() / 1000 - issuedAt) > 5 * 60 ||
    typeof expectedDigest !== 'string' ||
    !timingSafeEqual(await hexDigest(rawBody), expectedDigest)
  ) {
    throw new Error('Plaid webhook signature validation failed.')
  }

  return signature
}

async function findLocalItem(
  plaidItemId: string,
): Promise<{ id: string; status: string } | null> {
  const { data, error } = await getServiceRoleClient()
    .from('plaid_items')
    .select('id, status')
    .eq('plaid_item_id', plaidItemId)
    .maybeSingle()

  if (error) {
    throw new Error('The Plaid connection could not be loaded.')
  }

  return data ?? null
}

async function recordWebhookDelivery(
  deliveryKey: string,
  itemId: string,
): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from('plaid_webhook_events')
    .insert({
      delivery_key: deliveryKey,
      plaid_item_id: itemId,
    })

  if (!error) {
    return
  }

  if (error.code === '23505') {
    return
  }

  throw new Error('The Plaid webhook could not be recorded.')
}

async function updateItemError(
  itemId: string,
  errorCode: string,
): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from('plaid_items')
    .update({
      last_error_code: errorCode,
      status:
        errorCode === 'ITEM_LOGIN_REQUIRED' ||
        errorCode === 'PENDING_DISCONNECT' ||
        errorCode === 'PENDING_EXPIRATION'
          ? 'needs_reconnect'
          : 'error',
      sync_started_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .neq('status', 'disconnected')

  if (error) {
    throw new Error('The Plaid connection error could not be recorded.')
  }
}

async function markItemRepaired(itemId: string): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from('plaid_items')
    .update({
      last_error_code: null,
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .neq('status', 'disconnected')

  if (error) {
    throw new Error('The repaired Plaid connection could not be recorded.')
  }
}

async function revokeItemFromWebhook(
  itemId: string,
  errorCode: string,
): Promise<void> {
  const { error } = await getServiceRoleClient().rpc(
    'revoke_plaid_item_from_webhook',
    {
      p_item_id: itemId,
      p_error_code: errorCode,
    },
  )

  if (error) {
    throw new Error('The revoked Plaid connection could not be secured.')
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405 })
  }

  const rawBody = await request.text()
  let webhook: PlaidWebhook
  let signature: string

  try {
    signature = await verifyWebhook(request, rawBody)
    const body: unknown = JSON.parse(rawBody)

    if (!isPlaidWebhook(body)) {
      return new Response('Invalid webhook payload.', { status: 400 })
    }

    webhook = body
  } catch (error) {
    logExternalServiceError('Plaid webhook verification failed.', error)
    return new Response('Invalid webhook.', { status: 400 })
  }

  try {
    const item = await findLocalItem(webhook.item_id)

    if (!item || item.status === 'disconnected') {
      return new Response('Unknown Item.', { status: 200 })
    }

    const itemId = item.id

    if (
      webhook.webhook_type === 'TRANSACTIONS' &&
      webhook.webhook_code === 'SYNC_UPDATES_AVAILABLE'
    ) {
      const result = await syncPlaidItem(itemId, {
        initialUpdateComplete: webhook.initial_update_complete === true,
        historicalUpdateComplete: webhook.historical_update_complete === true,
      })

      if (!result.claimed) {
        throw new Error('Plaid Item synchronization is already in progress.')
      }
    } else if (webhook.webhook_type === 'ITEM') {
      if (
        webhook.webhook_code === 'USER_PERMISSION_REVOKED'
      ) {
        await revokeItemFromWebhook(itemId, webhook.webhook_code)
      } else if (
        webhook.webhook_code === 'USER_ACCOUNT_REVOKED' &&
        typeof webhook.account_id === 'string'
      ) {
        const { error } = await getServiceRoleClient().rpc(
          'revoke_plaid_account_from_webhook',
          {
            p_item_id: itemId,
            p_plaid_account_id: webhook.account_id,
          },
        )

        if (error) {
          throw new Error('The revoked Plaid account could not be removed.')
        }
      } else if (
        webhook.webhook_code === 'PENDING_DISCONNECT' ||
        webhook.webhook_code === 'PENDING_EXPIRATION'
      ) {
        await updateItemError(itemId, webhook.webhook_code)
      } else if (webhook.webhook_code === 'LOGIN_REPAIRED') {
        await markItemRepaired(itemId)
      } else if (typeof webhook.error?.error_code === 'string') {
        await updateItemError(itemId, webhook.error.error_code)
      }
    }

    await recordWebhookDelivery(
      await hexDigest(`${signature}:${rawBody}`),
      itemId,
    )
    return new Response('Webhook processed.', { status: 200 })
  } catch (error) {
    logExternalServiceError('Plaid webhook processing failed.', error)
    return jsonResponse(request, 500, {
      error: 'The Plaid webhook could not be processed.',
    })
  }
})
