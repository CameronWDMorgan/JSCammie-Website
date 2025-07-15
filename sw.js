// Service Worker for JSCammie Website
// Version 1.0.0

const CACHE_NAME = 'jscammie-cache-v1.0.0';
const STATIC_CACHE_NAME = 'jscammie-static-v1.0.0';
const DYNAMIC_CACHE_NAME = 'jscammie-dynamic-v1.0.0';

// Assets to cache immediately
const STATIC_ASSETS = [
    '/',
    '/style.css',
    '/ai-style.css',
    '/android-chrome-192x192.png',
    '/android-chrome-512x512.png',
    '/favicon.ico'
];

// Assets that should never be cached
const NO_CACHE_PATTERNS = [
    '/api/',
    '/image-history',
    '/settings',
    '/profile'
];

// Install event - cache critical assets
self.addEventListener('install', event => {
    console.log('Service Worker installing...');
    event.waitUntil(
        caches.open(STATIC_CACHE_NAME)
            .then(cache => {
                console.log('Caching static assets...');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                // Force the waiting service worker to become the active service worker
                return self.skipWaiting();
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
    console.log('Service Worker activating...');
    event.waitUntil(
        caches.keys()
            .then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== STATIC_CACHE_NAME && 
                            cacheName !== DYNAMIC_CACHE_NAME) {
                            console.log('Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                // Ensure the service worker takes control immediately
                return self.clients.claim();
            })
    );
});

// Fetch event - handle requests with caching strategy
self.addEventListener('fetch', event => {
    // Only handle http/https requests
    if (!event.request.url.startsWith('http')) {
        return;
    }
    
    try {
        const requestUrl = new URL(event.request.url);
        
        // Skip caching for certain patterns
        if (NO_CACHE_PATTERNS.some(pattern => requestUrl.pathname.includes(pattern))) {
            // Always fetch from network for dynamic content
            event.respondWith(
                fetch(event.request).catch(error => {
                    console.log('Fetch failed for:', event.request.url, error);
                    // Return a proper error response instead of throwing
                    return new Response('Network error', {
                        status: 503,
                        statusText: 'Service Unavailable'
                    });
                })
            );
            return;
        }
        
        // Handle different types of requests
        if (event.request.destination === 'document') {
            // For HTML pages - network first, then cache
            event.respondWith(networkFirstStrategy(event.request));
        } else if (event.request.destination === 'style' || 
                   event.request.destination === 'script' ||
                   event.request.destination === 'image') {
            // For static assets - cache first, then network
            event.respondWith(cacheFirstStrategy(event.request));
        } else {
            // Default strategy - network first
            event.respondWith(networkFirstStrategy(event.request));
        }
    } catch (error) {
        console.error('Service worker fetch event error:', error);
        // Fallback to normal fetch with error handling
        event.respondWith(
            fetch(event.request).catch(fetchError => {
                console.error('Fallback fetch failed:', fetchError);
                return new Response('Service Worker Error', {
                    status: 503,
                    statusText: 'Service Unavailable'
                });
            })
        );
    }
});

// Network first strategy (good for HTML pages)
async function networkFirstStrategy(request) {
    try {
        const networkResponse = await fetch(request);
        
        // Only cache GET requests with successful responses
        if (networkResponse.status === 200 && request.method === 'GET') {
            try {
                const cache = await caches.open(DYNAMIC_CACHE_NAME);
                await cache.put(request, networkResponse.clone());
            } catch (cacheError) {
                console.log('Failed to cache response:', cacheError);
                // Continue without caching
            }
        }
        
        return networkResponse;
    } catch (error) {
        console.log('Network request failed:', request.url, error);
        
        // If network fails, try cache (only for GET requests)
        if (request.method === 'GET') {
            try {
                const cachedResponse = await caches.match(request);
                if (cachedResponse) {
                    console.log('Serving from cache:', request.url);
                    return cachedResponse;
                }
            } catch (cacheError) {
                console.log('Cache lookup failed:', cacheError);
            }
        }
        
        // If no cache either, return proper error response
        return new Response('Network Error', {
            status: 503,
            statusText: 'Service Unavailable'
        });
    }
}

// Cache first strategy (good for static assets)
async function cacheFirstStrategy(request) {
    // Only handle GET requests for caching
    if (request.method !== 'GET') {
        return fetch(request);
    }
    
    try {
        // Check if we have a cached version
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            // Check if it's a versioned asset that might be stale
            const url = new URL(request.url);
            if (url.searchParams.has('v')) {
                // For versioned assets, also try to update in background
                fetch(request).then(response => {
                    if (response.status === 200) {
                        caches.open(STATIC_CACHE_NAME).then(cache => {
                            return cache.put(request, response);
                        }).catch(cacheError => {
                            console.log('Background cache update failed:', cacheError);
                        });
                    }
                }).catch(fetchError => {
                    console.log('Background fetch failed:', fetchError);
                });
            }
            
            return cachedResponse;
        }
    } catch (cacheError) {
        console.log('Cache lookup failed:', cacheError);
    }
    
    // If not in cache, fetch from network
    try {
        const networkResponse = await fetch(request);
        
        if (networkResponse.status === 200) {
            try {
                const cache = await caches.open(STATIC_CACHE_NAME);
                await cache.put(request, networkResponse.clone());
            } catch (cacheError) {
                console.log('Failed to cache response:', cacheError);
                // Continue without caching
            }
        }
        
        return networkResponse;
    } catch (error) {
        console.log('Network fetch failed:', request.url, error);
        return new Response('Network Error', {
            status: 503,
            statusText: 'Service Unavailable'
        });
    }
}

// Listen for messages from the main thread
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    } else if (event.data && event.data.type === 'CLEAR_CACHE') {
        // Clear all caches when requested
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => caches.delete(cacheName))
            );
        }).then(() => {
            // Send response back to client
            // Check if ports are available (MessageChannel) or use client messaging
            if (event.ports && event.ports.length > 0) {
                event.ports[0].postMessage({success: true});
            } else {
                // Fallback: broadcast to all clients
                self.clients.matchAll().then(clients => {
                    clients.forEach(client => {
                        client.postMessage({type: 'CACHE_CLEARED', success: true});
                    });
                });
            }
        }).catch(error => {
            console.error('Failed to clear caches:', error);
            // Send error response
            if (event.ports && event.ports.length > 0) {
                event.ports[0].postMessage({success: false, error: error.message});
            } else {
                self.clients.matchAll().then(clients => {
                    clients.forEach(client => {
                        client.postMessage({type: 'CACHE_CLEARED', success: false, error: error.message});
                    });
                });
            }
        });
    }
}); 