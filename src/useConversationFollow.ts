import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Remember the reader's position before content grows, rather than measuring after it. */
export function useConversationFollow(
  feed: RefObject<HTMLDivElement | null>,
  sessionId: string,
  visible: boolean,
  revision: unknown,
) {
  const pinned = useRef(true);
  const [following, setFollowing] = useState(true);
  const resume = () => {
    pinned.current = true;
    setFollowing(true);
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    pinned.current = true;
    setFollowing(true);
    const el = feed.current;
    if (!el || !visible) return;
    let lastTop = el.scrollTop;
    const scroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      if (nearBottom) pinned.current = true;
      else if (el.scrollTop < lastTop - 1) pinned.current = false;
      lastTop = el.scrollTop;
      setFollowing(pinned.current);
    };
    const follow = () => {
      if (pinned.current && window.getSelection()?.isCollapsed !== false) {
        el.scrollTop = el.scrollHeight;
        lastTop = el.scrollTop;
      }
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        pinned.current = false;
        setFollowing(false);
      }
    };
    const resize = new ResizeObserver(follow);
    resize.observe(el);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of el.children) resize.observe(child);
      follow();
    };
    const mutation = new MutationObserver(observeChildren);
    mutation.observe(el, { childList: true });
    observeChildren();
    el.addEventListener('scroll', scroll, { passive: true });
    el.addEventListener('wheel', wheel, { passive: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
      el.removeEventListener('scroll', scroll);
      el.removeEventListener('wheel', wheel);
    };
  }, [feed, sessionId, visible]);
  useLayoutEffect(() => {
    const el = feed.current;
    if (el && pinned.current && window.getSelection()?.isCollapsed !== false)
      el.scrollTop = el.scrollHeight;
  }, [feed, revision]);
  return { following, resume };
}
