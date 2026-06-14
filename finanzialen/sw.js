/* Service Worker Offline Cache & Synchronization Manager */

// Preserved Firebase Web App configuration [3]
const firebaseConfig = {
  apiKey: "AIzaSyCvKICFZCwQz5e70HTLDA_eDD4Us8XqNas",
  authDomain: "finances-ed83f.firebaseapp.com",
  projectId: "finances-ed83f",
  storageBucket: "finances-ed83f.firebasestorage.app",
  messagingSenderId: "707569388994",
  appId: "1:707569388994:web:f23232e15d439df1ba5a5b",
  measurementId: "G-6SNL4MJZVK"
};

// Import compat Firebase modules inside worker thread [3]
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js');

const CACHE_NAME = 'budget-tracker-cloud-cache-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore-compat.js'
];

// Open IndexedDB inside Worker context [1]
function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('BudgetDatabase_v2', 1);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function getQueueItem(dbInstance, key) {
  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteQueueItem(dbInstance, key) {
  return new Promise((resolve, reject) => {
    const tx = dbInstance.transaction('queue', 'readwrite');
    const store = tx.objectStore('queue');
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Background Sync Task Handler [2]
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-budget') {
    event.waitUntil(syncLocalStoreToCloud());
  }
});

async function syncLocalStoreToCloud() {
  try {
    const idbInstance = await openIDB();
    const queueItem = await getQueueItem(idbInstance, 'pending_sync');
    
    if (queueItem) {
      if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
      const firestoreDb = firebase.firestore();
      const docRef = firestoreDb.collection('budgets').doc('default_budget_v2');
      
      const doc = await docRef.get();
      // Only push newer local data [3]
      if (!doc.exists || queueItem.updatedAt > doc.data().updatedAt) {
        await docRef.set({
          payload: queueItem.payload,
          updatedAt: queueItem.updatedAt
        });
      }
      // Clear offline mutations cache [1, 2]
      await deleteQueueItem(idbInstance, 'pending_sync');
      console.log('[SW] Background Synchronization complete.');
    }
  } catch (error) {
    console.error('[SW] Background synchronization failed:', error);
    throw error; // Let browser reschedule sync retry [2]
  }
}

// Service worker cache strategies
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((key) => {
        if (key !== CACHE_NAME) return caches.delete(key);
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => cachedResponse || fetch(event.request))
  );
});
