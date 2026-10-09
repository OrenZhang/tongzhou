import { useEffect, useState } from 'react';
import type { TongzhouAPI } from '../shared/types';
import type { View } from './views';

export function useNavigation(api: TongzhouAPI) {
  const [view, setView] = useState<View>('workspace');
  const [knowledgeTarget, setKnowledgeTarget] = useState<{ id: string; libraryId: string }>();
  const [knowledgeSection, setKnowledgeSection] = useState<'workspace' | 'artifacts'>('workspace');
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('tongzhou-sidebar') !== 'closed',
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    localStorage.setItem('tongzhou-sidebar', sidebarOpen ? 'open' : 'closed');
  }, [sidebarOpen]);
  useEffect(() => {
    const shortcuts = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'k' && !document.querySelector('.modal-backdrop')) {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (
        e.key.toLowerCase() === 'b' &&
        !document.querySelector('.modal-backdrop') &&
        !(e.target instanceof Element && e.target.closest('input,textarea,[contenteditable=true]'))
      ) {
        e.preventDefault();
        setSidebarOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, []);
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type === 'navigate') setView(event.view);
      }),
    [api],
  );
  return {
    view,
    setView,
    knowledgeTarget,
    setKnowledgeTarget,
    knowledgeSection,
    setKnowledgeSection,
    sidebarOpen,
    setSidebarOpen,
    paletteOpen,
    setPaletteOpen,
  };
}
