import { MeshportError } from '../errors.js';

export const MAX_DOWNLOAD = 500 * 1024 * 1024;

// Fetch with a timeout. `fetchImpl` is injectable so tests never touch the network.
export function request(fetchImpl, url, options = {}, timeoutMs = 30000) {
  return fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

// Maps an HTTP status from a 3D service to something a person can act on.
export function statusError(service, status, extra = {}) {
  if (status === 401) {
    return new MeshportError(
      `${service} did not accept your API key.`,
      `Open Settings, paste a fresh ${service} key and save.`,
      'bad-key'
    );
  }
  if (status === 403) {
    return new MeshportError(
      extra.forbidden || `${service} says you are not allowed to do this.`,
      extra.forbiddenHint || '',
      'forbidden'
    );
  }
  if (status === 404) {
    return new MeshportError(extra.notFound || `${service} could not find that item.`, 'Check the link or ID and try again.', 'not-found');
  }
  if (status === 429) {
    return new MeshportError(`${service} is rate limiting requests.`, 'Wait a minute and try again.', 'rate-limit');
  }
  return new MeshportError(`${service} answered with an error (HTTP ${status}).`, 'Try again later.', 'http');
}

export async function downloadBuffer(fetchImpl, url, onProgress) {
  const res = await request(fetchImpl, url, {}, 120000);
  if (!res.ok) {
    throw new MeshportError(
      `The file download failed (HTTP ${res.status}).`,
      res.status === 403 || res.status === 400 ? 'The download link may have expired. Start the job again.' : 'Try again later.',
      'download'
    );
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_DOWNLOAD) throw new MeshportError('The file is larger than 500 MB.', 'This app does not handle files that large.', 'too-big');

  if (!res.body || !res.body.getReader) {
    return Buffer.from(await res.arrayBuffer());
  }
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > MAX_DOWNLOAD) throw new MeshportError('The file is larger than 500 MB.', '', 'too-big');
    chunks.push(value);
    if (onProgress && total) onProgress(got / total);
  }
  return Buffer.concat(chunks);
}
