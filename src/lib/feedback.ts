export function errorMessage(error: unknown) {
  return String(error)
    .replace(/^Error:\s*Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}
