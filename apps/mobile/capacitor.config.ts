import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.videoeditor.app',
  appName: 'Video Editor',
  webDir: 'dist',
  plugins: {
    SystemBars: {
      // Injects CSS variables (--safe-area-inset-*) into the webview so our
      // landscape safe-area padding works natively on edge-to-edge displays.
      insetsHandling: 'css',
    }
  }
};

export default config;
