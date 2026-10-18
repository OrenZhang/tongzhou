import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale } from '../shared/i18n';

export const useLocale = () => useSyncExternalStore(subscribeLocale, getLocale, getLocale);
