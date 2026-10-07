import { createContext } from 'react';
import type { Attachment } from '../../shared/types';

export const FilePreviewContext = createContext<(file: Attachment) => void>(() => {});
