// IndexedDB-backed image store. Batch metadata stays in localStorage for
// instant synchronous reads; image arrays (~30-80KB each) live here so the
// 5MB localStorage cap doesn't constrain how many batches we can cache.
//
// iOS Safari gives IndexedDB a much larger quota (typically 50MB+, often
// hundreds of MB), enough for hundreds of batches with their screenshots.
//
// All functions degrade gracefully when IDB isn't available (Safari Private
// browsing, very old browsers): they no-op and the app falls back to
// fetching images from the server on demand.

import { openDB } from 'idb';

const DB_NAME = 'batchwise';
const DB_VERSION = 1;
const STORE = 'images';

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      }
    }).catch(err => {
      console.warn('IDB unavailable; image cache disabled', err);
      return null;
    });
  }
  return dbPromise;
}

export async function getImages(batchId) {
  try {
    const db = await getDb();
    if (!db) return null;
    return (await db.get(STORE, batchId)) || null;
  } catch (e) {
    console.warn('getImages failed', batchId, e);
    return null;
  }
}

export async function setImages(batchId, images) {
  try {
    const db = await getDb();
    if (!db) return;
    if (!Array.isArray(images) || images.length === 0) {
      await db.delete(STORE, batchId);
      return;
    }
    await db.put(STORE, images, batchId);
  } catch (e) {
    console.warn('setImages failed', batchId, e);
  }
}

export async function deleteImages(batchId) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.delete(STORE, batchId);
  } catch (e) {
    console.warn('deleteImages failed', batchId, e);
  }
}

// Useful for diagnostics or eventually for orphan cleanup.
export async function getAllImageIds() {
  try {
    const db = await getDb();
    if (!db) return [];
    return await db.getAllKeys(STORE);
  } catch (e) {
    return [];
  }
}
