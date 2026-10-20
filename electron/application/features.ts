import { updatesPlugin } from './features/updates';
import { powerPlugin } from './features/power';
import { networkPlugin } from './features/network';
import { appearancePlugin } from './features/appearance';
import { accountsPlugin } from './features/accounts';
import { computerPlugin } from './features/computer';
import { importsPlugin } from './features/imports';
import { providersPlugin } from './features/providers';

export const desktopFeatures = [
  updatesPlugin,
  powerPlugin,
  networkPlugin,
  appearancePlugin,
  accountsPlugin,
  computerPlugin,
  importsPlugin,
  providersPlugin,
];
