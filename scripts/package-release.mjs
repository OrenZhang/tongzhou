const signedMac = process.platform === 'darwin' && !!process.env.CSC_LINK;
if (
  signedMac &&
  !(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
)
  throw new Error('Signed macOS releases also require notarization credentials');
const { build } = await import('electron-builder');
await build({ publish: 'never', config: { extraMetadata: { tongzhouMacAutoUpdate: signedMac } } });
