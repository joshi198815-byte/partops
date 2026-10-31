import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Cáscara Android de PartOps.
 *
 * **Carga la web publicada, no un bundle.** El APK no es una copia congelada del sistema: es una
 * ventana con cámara, vibración y notificaciones apuntando a la misma aplicación que corre en el
 * navegador. Así el bodeguero recibe cada corrección el mismo día, sin reinstalar nada, y no hay dos
 * versiones de PartOps que se comporten distinto en el mostrador.
 *
 * El precio es que sin red no hay app. Por eso `www/index.html` no es un marcador: redirige y, si no
 * hay respuesta en cuatro segundos, abre `offline.html` con la marca y el aviso de que lo guardado
 * sale solo cuando vuelva la señal.
 *
 * `androidScheme: 'https'` no es cosmético: con `http://localhost` el navegador interno trata el
 * origen como inseguro y la sesión con cookie `Secure` no viaja.
 */
const config: CapacitorConfig = {
  appId: 'gt.partops.app',
  appName: 'PartOps',
  webDir: 'www',
  server: {
    url: process.env.CAP_SERVER_URL ?? 'https://app.partops.autos',
    cleartext: false,
    androidScheme: 'https',
  },
  android: {
    // El catálogo y las fotos de piezas van por https; mezclar contenido rompería la sesión.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      backgroundColor: '#16324F',
      showSpinner: false,
      launchAutoHide: false,
      launchShowDuration: 0,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#16324F',
    },
    PushNotifications: {
      // El canal se crea desde la app con el nombre del negocio; aquí solo el color del aviso.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
