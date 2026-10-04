export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const longPaste = (text: string) => text.length > 4000 || text.split(/\r?\n/).length > 80;
