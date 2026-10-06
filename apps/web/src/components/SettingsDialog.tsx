import { useSettingsDialogStore } from '../store/settingsDialogStore';
import { useThemeStore } from '../store/themeStore';
import { useBackHandler } from '../lib/backStack';
import {
  Sun,
} from 'lucide-react';
import { useEffect, useState } from 'react';

export function SettingsDialog() {
  const isOpen = useSettingsDialogStore((s) => s.isOpen);

  if (!isOpen) return null;
  return <SettingsDialogContent />;
}

function SettingsDialogContent() {
  const close = useSettingsDialogStore((s) => s.close);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  
  // Animation state for mount/unmount
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const handleClose = () => {
    setMounted(false);
    setTimeout(close, 250);
  };

  useBackHandler(true, handleClose);

  return (
    <div className={`settings-modal ${mounted ? 'settings-modal--visible' : ''}`} role="dialog" aria-modal="true">
      <div className="settings-modal__backdrop" onClick={handleClose} />
      <div className="settings-modal__sheet">
        <header className="settings-modal__header">
          <button type="button" className="settings-modal__close" onClick={handleClose} aria-label="Close Settings">
            ✕
          </button>
          <h2>Settings</h2>
        </header>

        <div className="settings-modal__body">


          <section className="settings-section">
            <h3 className="settings-section__title">Editor</h3>
            <div className="settings-card">
              <button className="settings-item" type="button" onClick={toggleTheme}>
                <Sun className="settings-item__icon" />
                <div className="settings-item__content">
                  <span className="settings-item__label">Appearance</span>
                  <span className="settings-item__sublabel">
                    {theme === 'dark' ? 'Dark theme active (Base)' : 'Light theme active (Base)'}
                  </span>
                </div>
                <div className={`settings-toggle ${theme === 'light' ? 'settings-toggle--on' : ''}`}>
                  <div className="settings-toggle__knob">
                    {theme === 'light' && <Sun size={12} className="settings-toggle__icon" />}
                  </div>
                </div>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
