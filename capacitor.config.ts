import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.mealieconnect.app',
  appName: 'Mealie Connect',
  webDir: 'dist',
  server: {
    hostname: 'app.mealieconnect',
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 250,
      backgroundColor: '#f7f3ed',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#f7f3ed',
      overlaysWebView: false,
    },
  },
}

export default config
