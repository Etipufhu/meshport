// Errors that are safe to show to the user as they are.
// `message` says what happened, `hint` says what to do about it.
export class MeshportError extends Error {
  constructor(message, hint = '', code = 'error') {
    super(message);
    this.name = 'MeshportError';
    this.hint = hint;
    this.code = code;
  }
}

// Turns any thrown value into { message, hint } for the UI.
export function describeError(err) {
  if (err instanceof MeshportError) return { message: err.message, hint: err.hint, code: err.code };
  if (err && err.cause && err.cause.code === 'ENOTFOUND') {
    return { message: 'Could not reach the server.', hint: 'Check your internet connection.', code: 'network' };
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { message: 'The server took too long to answer.', hint: 'Try again in a minute.', code: 'timeout' };
  }
  if (err && err.message === 'fetch failed') {
    return { message: 'Network request failed.', hint: 'Check your internet connection and try again.', code: 'network' };
  }
  return { message: 'Something went wrong: ' + (err && err.message ? err.message : String(err)), hint: 'If it keeps happening, please open an issue with this message.', code: 'unknown' };
}
