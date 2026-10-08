/** Model gateway errors can arrive through App Server as a serialized HTTP error body. */
export function modelErrorMessage(error: unknown): string {
  let message =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error);
  for (let depth = 0; depth < 3; depth++) {
    if (!message.trim().startsWith('{')) break;
    try {
      const body = JSON.parse(message);
      const detail = body?.error?.message ?? body?.message;
      if (typeof detail !== 'string' || !detail.trim()) break;
      message = detail;
    } catch {
      break;
    }
  }
  return message;
}
