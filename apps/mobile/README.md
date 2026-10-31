# PartOps Android

Cáscara Capacitor. **No es una copia de la aplicación**: el APK abre la web publicada
(`CAP_SERVER_URL`, por defecto `https://app.partops.autos`). Lo que agrega sobre el navegador es lo que
el navegador no puede dar en una bodega:

| Función                                            | Plugin                                |
| -------------------------------------------------- | ------------------------------------- |
| Escanear códigos con enfoque automático y poca luz | `@capacitor-mlkit/barcode-scanning`   |
| Vibración al confirmar una lectura                 | `@capacitor/haptics`                  |
| Pantalla encendida mientras se prepara un pedido   | `@capacitor-community/keep-awake`     |
| Compartir el recibo por WhatsApp                   | `@capacitor/share`                    |
| Avisos con la app cerrada                          | `@capacitor/push-notifications` (FCM) |

Todo el puente vive en `apps/web/src/lib/native.ts` y degrada sin lanzar: la misma pantalla corre en
el navegador de la bodega y no pregunta en qué aparato está.

## Primera vez

```bash
pnpm install
pnpm --filter @partops/mobile shell     # genera www/index.html y www/offline.html
pnpm --filter @partops/mobile add:android
```

`add:android` solo se corre una vez: crea `android/` y ya está en el repo. Volver a correrlo pisa los
cambios hechos a mano en `AndroidManifest.xml` y `app/build.gradle`.

## Ciclo normal

```bash
pnpm --filter @partops/mobile sync      # plantillas + cap sync
pnpm --filter @partops/mobile open      # abre Android Studio
```

## APK de prueba

```bash
cd apps/mobile/android
export ANDROID_HOME="$HOME/Android/Sdk"        # o C:\Users\<tú>\AppData\Local\Android\Sdk
./gradlew assembleDebug                        # gradlew.bat en Windows
```

Sale en `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` (~31 MB con el SDK de ML Kit
incluido). Se instala con `adb install -r app-debug.apk` o pasándolo por WhatsApp.

## APK firmado

### Secretos de GitHub

| Secreto                     | Qué es                                                          |
| --------------------------- | --------------------------------------------------------------- |
| `ANDROID_KEYSTORE_B64`      | keystore `.jks` en base64: `base64 -w0 release.jks`             |
| `ANDROID_KEY_ALIAS`         | alias de la llave dentro del keystore                           |
| `ANDROID_KEYSTORE_PASSWORD` | contraseña del keystore                                         |
| `ANDROID_KEY_PASSWORD`      | contraseña de la llave (a veces la misma)                       |
| `FCM_GOOGLE_SERVICES_B64`   | `google-services.json` en base64 (opcional; sin él no hay push) |

### Primera llave

Se genera una sola vez y se guarda fuera del repo, con copia en el gestor de contraseñas. Perderla
significa publicar una app nueva con otro `applicationId`, porque Google Play rechaza un APK firmado
con otra llave.

```bash
keytool -genkeypair -v \
  -keystore release.jks -alias partops \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=PartOps, O=PartOps, L=Guatemala, C=GT"
```

### Por qué el keystore no está en el repo

Un keystore versionado es una llave privada pública: cualquiera que clone el repo puede firmar un APK
que Android acepta como actualización legítima de PartOps. `*.keystore`, `*.jks` y `*.aab` están en
`.gitignore` justamente por eso.
