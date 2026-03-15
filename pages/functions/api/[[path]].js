function buildUpstreamUrl(requestUrl) {
  const url = new URL(requestUrl);
  const upstreamPath = url.pathname.replace(/^\/api/, '') || '/';
  return `https://query-worker${upstreamPath}${url.search}`;
}

function forwardableHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('x-forwarded-proto');
  headers.delete('x-real-ip');
  return headers;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.QUERY_API) {
    return new Response(JSON.stringify({ error: 'QUERY_API service binding is not configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  const init = {
    method: request.method,
    headers: forwardableHeaders(request),
    redirect: 'manual'
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const upstreamRequest = new Request(buildUpstreamUrl(request.url), init);

  return env.QUERY_API.fetch(upstreamRequest);
}
