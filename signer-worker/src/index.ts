/**
 * Minimal API contract example for a private signer/storage backend.
 * This file is intentionally not production-complete.
 */

interface Env {
  ALLOW_ANON_DEMO?: string
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

async function verifySession(request: Request, env: Env): Promise<boolean> {
  if (env.ALLOW_ANON_DEMO === 'true') {
    return true
  }

  const authHeader = request.headers.get('authorization')
  return authHeader !== null && authHeader.startsWith('Bearer ')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await verifySession(request, env))) {
      return unauthorized()
    }

    const url = new URL(request.url)

    if (url.pathname === '/media' && request.method === 'GET') {
      // Replace with private datastore list call.
      return json({ records: [] })
    }

    if (url.pathname === '/media' && request.method === 'POST') {
      // Replace with private datastore write call.
      return new Response(null, { status: 204 })
    }

    return new Response('Not found', { status: 404 })
  },
}
