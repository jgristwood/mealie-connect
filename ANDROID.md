# Mealie Connect Android (Capacitor)

This project uses **one React/Vite codebase** for:

- Web app
- PWA
- Android app (via Capacitor WebView wrapper)

No React Native or separate Kotlin/Jetpack Compose application logic is used.

---

## Prerequisites

- Node.js **22 LTS** (recommended)
- npm (this repo uses `package-lock.json`)
- Android Studio (latest stable)
- Android SDK platform + build tools matching `compileSdkVersion` in [variables.gradle](C:/Users/Jody/mealie-connect/android/variables.gradle)
- JDK 21 (Android Studio bundled JDK is fine)

---

## Installed Capacitor packages

- `@capacitor/core`
- `@capacitor/cli`
- `@capacitor/android`
- `@capacitor/app`
- `@capacitor/browser`
- `@capacitor/keyboard`
- `@capacitor/network`
- `@capacitor/preferences`
- `@capacitor/splash-screen`
- `@capacitor/status-bar`
- `@aparajita/capacitor-secure-storage`
- `@capacitor-community/keep-awake`
- `@capacitor/assets` (asset generation tool)

---

## Capacitor configuration

See [capacitor.config.ts](C:/Users/Jody/mealie-connect/capacitor.config.ts):

- `appId`: `com.mealieconnect.app`
- `appName`: `Mealie Connect`
- `webDir`: `dist`
- native hostname: `app.mealieconnect`
- Android mixed content disabled (`allowMixedContent: false`)

The Android app loads the **bundled local web build** from `dist/` (not a hosted URL).

---

## Development workflow

1. Install dependencies:

```bash
npm install
```

2. Build web assets:

```bash
npm run build
```

3. Sync web assets/plugins into Android:

```bash
npm run cap:sync:android
```

4. Open Android Studio:

```bash
npm run cap:open:android
```

---

## Command-line Android builds

Debug APK:

```bash
npm run android:build:debug
```

Release APK (unsigned unless signing env vars are set):

```bash
npm run android:build:release
```

Release AAB:

```bash
npm run android:bundle:release
```

---

## APK locations

- Debug APK: [app-debug.apk](C:/Users/Jody/mealie-connect/android/app/build/outputs/apk/debug/app-debug.apk)
- Release APK: [app-release.apk](C:/Users/Jody/mealie-connect/android/app/build/outputs/apk/release/app-release.apk)
- Release AAB: [app-release.aab](C:/Users/Jody/mealie-connect/android/app/build/outputs/bundle/release/app-release.aab)

---

## Installing debug APK on a phone

Option 1 (ADB):

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Option 2:

- Copy APK to device
- Enable “Install unknown apps” for your file manager
- Open APK and install

---

## Release signing (do not commit keys)

Create a keystore (example):

```bash
keytool -genkeypair -v -keystore mealieconnect-upload.jks -alias mealieconnect -keyalg RSA -keysize 4096 -validity 3650
```

Set environment variables (PowerShell example):

```powershell
$env:MEALIE_CONNECT_UPLOAD_STORE_FILE="C:\secure\keys\mealieconnect-upload.jks"
$env:MEALIE_CONNECT_UPLOAD_STORE_PASSWORD="your-store-password"
$env:MEALIE_CONNECT_UPLOAD_KEY_ALIAS="mealieconnect"
$env:MEALIE_CONNECT_UPLOAD_KEY_PASSWORD="your-key-password"
```

Then build:

```bash
npm run android:build:release
npm run android:bundle:release
```

Signing config is wired in [build.gradle](C:/Users/Jody/mealie-connect/android/app/build.gradle) and only activates when all env vars are provided.

Never commit:

- `*.jks`
- `*.keystore`
- key passwords
- `android/local.properties`

---

## Android Studio workflow

1. Open [android/](C:/Users/Jody/mealie-connect/android)
2. Let Gradle sync
3. Select `app` run configuration
4. Run on emulator or connected device
5. For release artifacts: **Build > Generate Signed Bundle / APK**

---

## Testing checklist (manual)

- Sign in with Mealie password/token
- Switch between multiple saved profiles
- Browse recipes and details
- Cook Mode (wake lock auto-enabled while in Cook Mode)
- Dinner Roulette
- Meal planning and shopping list flows
- Import recipe URL flow
- Theme switching
- Android back button behavior (modal close > in-app back > exit at root)
- Offline/online transitions

---

## Network/security notes

- HTTPS is the recommended Mealie server configuration.
- On Android, Capacitor native HTTP is enabled in [capacitor.config.ts](C:/Users/Jody/mealie-connect/capacitor.config.ts), so direct Mealie API calls do not depend on browser CORS behavior.
- On Android, the app uses a dedicated Capacitor hostname (`https://app.mealieconnect`) rather than `https://localhost` to avoid stale PWA/service-worker cache collisions with the native shell.
- In a desktop browser (`npm run dev` / web app), CORS still applies. If your Mealie reverse proxy does not return the correct `Access-Control-Allow-Origin` headers, use the included local proxy or fix CORS on the Mealie host.
- Android cleartext HTTP is not globally enabled.
- If a user needs HTTP-only Mealie endpoints, add a scoped network security config rather than globally disabling protections.

---

## Troubleshooting

- Rebuild/sync web layer:
  - `npm run build`
  - `npm run cap:sync:android`
- Clean Android build:
  - `cd android && gradlew.bat clean`
- If Gradle sync fails in Android Studio, verify:
  - Android SDK installed for configured compile SDK
  - JDK 21 selected
  - internet access for dependency download

---

## Updating Capacitor / Android dependencies

1. Update packages in [package.json](C:/Users/Jody/mealie-connect/package.json)
2. Run:
   - `npm install`
   - `npx cap sync android`
3. Open Android Studio and allow Gradle migration updates if prompted
4. Re-run debug build and smoke test core flows
