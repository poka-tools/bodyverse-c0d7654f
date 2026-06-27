/* BODYVERSE Service Worker — full offline support.
   Precaches the app shell + all bundled libraries (three.js / chart.js / jszip)
   so the home-screen app works with no network (e.g. inside a gym).
   Bump CACHE_VERSION whenever any precached asset changes to force an update. */
const CACHE_VERSION = 'bodyverse-v5';

const PRECACHE = [
  './index-3d.html',
  './m.html',
  './manifest.webmanifest',
  './logo-data.js',
  './bodyverse-logo.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/favicon-192.png',
  './icons/favicon-512.png',
  './vendor/chartjs/chart.umd.min.js',
  './vendor/jszip/jszip.min.js',
  './vendor/three/three.module.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './vendor/three/addons/postprocessing/EffectComposer.js',
  './vendor/three/addons/postprocessing/RenderPass.js',
  './vendor/three/addons/postprocessing/UnrealBloomPass.js',
  './vendor/three/addons/postprocessing/OutputPass.js',
  './vendor/three/addons/postprocessing/Pass.js',
  './vendor/three/addons/postprocessing/ShaderPass.js',
  './vendor/three/addons/postprocessing/MaskPass.js',
  './vendor/three/addons/shaders/CopyShader.js',
  './vendor/three/addons/shaders/LuminosityHighPassShader.js',
  './vendor/three/addons/shaders/OutputShader.js'
];

// Absolute URL of the app shell, used as the offline navigation fallback.
const SHELL_URL = new URL('./index-3d.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle our own origin; let everything else hit the network normally.
  if (url.origin !== self.location.origin) return;

  // Navigations: serve cached shell when offline so the app always opens.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(SHELL_URL).then((r) => r || caches.match('./index-3d.html')))
    );
    return;
  }

  // Cache-first for everything we precached; network fallback otherwise.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
