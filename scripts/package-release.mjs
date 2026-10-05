// Actions exposes unconfigured Secrets as empty strings; builder treats an empty
// CSC_LINK as a file path, so omit it when no certificate was configured.
if (!process.env.CSC_LINK?.trim()) delete process.env.CSC_LINK;
const signedMac = process.platform === 'darwin' && !!process.env.CSC_LINK;
if (
  signedMac &&
  !(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
)
  throw new Error('Signed macOS releases also require notarization credentials');
const { build } = await import('electron-builder');
await build({ publish: 'never', config: { extraMetadata: { tongzhouMacAutoUpdate: signedMac } } });
