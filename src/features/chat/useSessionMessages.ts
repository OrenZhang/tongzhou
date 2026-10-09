import { useEffect, useRef, useState } from 'react';
import type { Message, TongzhouAPI } from '../../shared/types';

/** Loads history and merges streaming updates without leaking messages across chats. */
export function useSessionMessages(
  api: TongzhouAPI,
  sessionId: string,
  report: (error: unknown) => void,
) {
  const sessionRef = useRef(sessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type === 'message' && event.message.sessionId === sessionRef.current)
          setMessages((old) => {
            const index = old.findIndex((message) => message.id === event.message.id);
            return index < 0
              ? [...old, event.message]
              : old.map((message, i) => (i === index ? event.message : message));
          });
        if (event.type === 'messages-removed' && event.sessionId === sessionRef.current)
          setMessages((old) => old.filter((message) => !event.ids.includes(message.id)));
      }),
    [api],
  );
  useEffect(() => {
    let active = true;
    sessionRef.current = sessionId;
    setHasEarlier(false);
    setMessages((old) => old.filter((message) => message.sessionId === sessionId));
    if (sessionId)
      void api
        .messages(sessionId)
        .then((result) => {
          if (!active || sessionRef.current !== sessionId) return;
          setMessages((old) => {
            const merged = new Map(result.map((message) => [message.id, message]));
            for (const message of old.filter((message) => message.sessionId === sessionId))
              merged.set(message.id, message);
            return [...merged.values()];
          });
          setHasEarlier(result.length === 100);
        })
        .catch((error) => {
          if (active) report(error);
        });
    return () => {
      active = false;
    };
  }, [api, sessionId, report]);
  return { messages, setMessages, hasEarlier, setHasEarlier, sessionRef };
}
