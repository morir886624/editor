import { useInstallStore } from '../store/installStore';

/** Running as an installed app (standalone window), so hide the banner. */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari exposes this instead of the display-mode media query.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS/iPadOS never fires `beforeinstallprompt` — installs are manual there. */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as a Mac; disambiguate by touch support.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Toast prompting the user to install the app to their home screen / desktop.
 * On Chromium it fires the captured native prompt; on iOS (no such prompt) it
 * shows the manual Add-to-Home-Screen instructions instead.
 */
export function InstallPrompt() {
  const deferred = useInstallStore((s) => s.deferred);
  const installed = useInstallStore((s) => s.installed);
  const dismissed = useInstallStore((s) => s.dismissed);
  const setInstalled = useInstallStore((s) => s.setInstalled);
  const dismiss = useInstallStore((s) => s.dismiss);

  if (installed || dismissed || isStandalone()) return null;

  const ios = isIOS();
  // Nothing to show until Chromium offers a prompt — except on iOS, where no
  // prompt ever arrives but we can still guide the manual install.
  if (!deferred && !ios) return null;

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'accepted') setInstalled();
    else dismiss();
  }

  return (
    <div className="install-banner" role="dialog" aria-label="Installer l'application">
      <img className="install-banner__icon" src="/favicon.svg" alt="" width={28} height={28} />
      <div className="install-banner__body">
        <strong className="install-banner__title">Installer Video Editor</strong>
        <span className="install-banner__text">
          {ios
            ? 'Appuyez sur Partager puis « Sur l’écran d’accueil ».'
            : 'Ajoutez l’éditeur à votre écran d’accueil pour un accès plein écran.'}
        </span>
      </div>
      {!ios && (
        <button type="button" className="install-banner__action" onClick={install}>
          Installer
        </button>
      )}
      <button
        type="button"
        className="install-banner__close"
        onClick={dismiss}
        aria-label="Ignorer"
        title="Ignorer"
      >
        ×
      </button>
    </div>
  );
}
