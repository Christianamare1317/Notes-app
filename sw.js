/**
 * sw.js - Service Worker for Notes App (PWA)
 * 
 * Provides:
 * - Offline app shell caching (HTML, CSS, JS, manifest, brand icons)
 * - Cache-first strategy for static assets with network fallback
 * - Automatic cache cleanup on version updates
 * - Safe bypass for Supabase backend APIs, Auth, and Storage endpoints
 */

const CACHE_NAME = 'notes-app-cache-v1';

// Static App Shell assets to precache
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './logo.svg',
  './favicon.svg',
  './favicon.ico',
  './favicon-32x32.png',
  './favicon-16x16.png',
  './favicon-48x48.png',
  './apple-touch-icon.png',
  './icon-192x192.png',
  './icon-512x512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// 1. Install Event: Cache app shell assets and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Use map to cache each asset safely without failing the entire install on a single hiccup
      await Promise.all(
        PRECACHE_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url);
            if (response && response.ok) {
              await cache.put(url, response);
            }
          } catch (err) {
            console.warn(`[Service Worker] Precache warning for ${url}:`, err);
          }
        })
      );
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// 2. Activate Event: Clean up old caches from previous versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log(`[Service Worker] Removing old cache: ${name}`);
            return caches.delete(name);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// 3. Fetch Event: Cache-First strategy with Network Fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // A. Never intercept or cache non-GET requests (e.g. POST, PUT, DELETE)
  if (event.request.method !== 'GET') {
    return;
  }

  // B. Never cache Supabase backend endpoints (Auth, REST tables, Realtime, Storage)
  if (url.hostname.includes('supabase.co')) {
    return;
  }

  // C. Handle static assets & navigation requests
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      // If not in cache, fetch from network
      return fetch(event.request)
        .then((networkResponse) => {
          // Verify response validity before caching
          if (
            !networkResponse ||
            networkResponse.status !== 200 ||
            networkResponse.type === 'opaque' ||
            event.request.url.startsWith('chrome-extension')
          ) {
            return networkResponse;
          }

          // Cache a copy of the newly fetched static asset
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });

          return networkResponse;
        })
        .catch(() => {
          // Offline navigation fallback: serve index.html when offline
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
        });
    })
  );
});
