import { useSettingsDialogStore } from '../store/settingsDialogStore';
import { useThemeStore } from '../store/themeStore';
import { useBackHandler } from '../lib/backStack';
import {
  Star,
  HelpCircle,
  Shield,
  FileText,
  Mail,
  Sun,
  Mic,
  Languages,
  HardDrive,
  Sparkles,
  ChevronRight,
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
            <h3 className="settings-section__title">General</h3>
            <div className="settings-card">
              <button className="settings-item" type="button">
                <Star className="settings-item__icon" />
                <span className="settings-item__label">Rate us</span>
                <ChevronRight className="settings-item__chevron" />
              </button>
              <div className="settings-divider" />
              <button className="settings-item" type="button">
                <HelpCircle className="settings-item__icon" />
                <span className="settings-item__label">Help Center</span>
                <ChevronRight className="settings-item__chevron" />
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section__title">Preferences</h3>
            <div className="settings-card">
              <button className="settings-item" type="button">
                <Shield className="settings-item__icon" />
                <span className="settings-item__label">Privacy Policy</span>
                <ChevronRight className="settings-item__chevron" />
              </button>
              <div className="settings-divider" />
              <button className="settings-item" type="button">
                <FileText className="settings-item__icon" />
                <span className="settings-item__label">Terms of Use</span>
                <ChevronRight className="settings-item__chevron" />
              </button>
              <div className="settings-divider" />
              <button className="settings-item" type="button">
                <Mail className="settings-item__icon" />
                <span className="settings-item__label">Contact Us</span>
                <ChevronRight className="settings-item__chevron" />
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section__title">Studio & Reading</h3>
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
              <div className="settings-divider" />
              <button className="settings-item" type="button">
                <Mic className="settings-item__icon" />
                <div className="settings-item__content">
                  <span className="settings-item__label">Default Reciter</span>
                  <span className="settings-item__sublabel">Nasser Al-Qatami</span>
                </div>
                <ChevronRight className="settings-item__chevron" />
              </button>
              <div className="settings-divider" />
              <button className="settings-item" type="button">
                <Languages className="settings-item__icon" />
                <div className="settings-item__content">
                  <span className="settings-item__label">Primary Translation</span>
                  <span className="settings-item__sublabel">King Fahad Quran Complex</span>
                </div>
                <ChevronRight className="settings-item__chevron" />
              </button>
              <div className="settings-divider" />
              <button className="settings-item" type="button">
                <HardDrive className="settings-item__icon" />
                <div className="settings-item__content">
                  <span className="settings-item__label">Storage & Offline Voices</span>
                  <span className="settings-item__sublabel">17 videos (176.7 MB) • 1213 audio (556.8 MB)</span>
                </div>
                <ChevronRight className="settings-item__chevron" />
              </button>
              <div className="settings-divider" />
              <button className="settings-item" type="button">
                <Sparkles className="settings-item__icon" />
                <span className="settings-item__label">Starter Walkthrough & Tour</span>
                <ChevronRight className="settings-item__chevron" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
