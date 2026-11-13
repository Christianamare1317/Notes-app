/**
 * db.js — Local-First IndexedDB layer for Notes App
 *
 * Provides a promise-based API over IndexedDB for:
 *   - Notes (title, content, timestamps, sync status)
 *   - File Attachments (binary Blob data stored locally alongside each note)
 *   - Sync Queue (pending operations to push to Supabase when back online)
 *
 * Data Model
 * ──────────
 * Object Store: "notes"
 *   { id, user_id, title, content, created_at, updated_at,
 *     sync_status: "synced" | "pending_create" | "pending_update" | "pending_delete" }
 *
 * Object Store: "note_files"
 *   { id, note_id, user_id, file_name, mime_type, size_bytes, created_at,
 *     blob,           ← raw File/Blob stored locally
 *     file_path,      ← Supabase storage path (empty until synced)
 *     sync_status: "synced" | "pending_upload" | "pending_delete" }
 *
 * Object Store: "sync_queue"
 *   { id (auto-increment), entity: "note"|"file", operation: "create"|"update"|"delete",
 *     entity_id, payload (JSON), created_at }
 */

const DB_NAME    = "notes-app-local";
const DB_VERSION = 1;

let _db = null;

// ─── Open / Initialise Database ───────────────────────────────────────────────

/**
 * Open (or upgrade) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // ── notes store ──────────────────────────────────────────────
      if (!db.objectStoreNames.contains("notes")) {
        const notesStore = db.createObjectStore("notes", { keyPath: "id" });
        notesStore.createIndex("user_id",     "user_id",     { unique: false });
        notesStore.createIndex("sync_status", "sync_status", { unique: false });
        notesStore.createIndex("created_at",  "created_at",  { unique: false });
      }

      // ── note_files store ─────────────────────────────────────────
      if (!db.objectStoreNames.contains("note_files")) {
        const filesStore = db.createObjectStore("note_files", { keyPath: "id" });
        filesStore.createIndex("note_id",     "note_id",     { unique: false });
        filesStore.createIndex("user_id",     "user_id",     { unique: false });
        filesStore.createIndex("sync_status", "sync_status", { unique: false });
      }

      // ── sync_queue store ─────────────────────────────────────────
      if (!db.objectStoreNames.contains("sync_queue")) {
        const syncStore = db.createObjectStore("sync_queue", {
          keyPath: "id",
          autoIncrement: true
        });
        syncStore.createIndex("entity",     "entity",     { unique: false });
        syncStore.createIndex("entity_id",  "entity_id",  { unique: false });
        syncStore.createIndex("created_at", "created_at", { unique: false });
      }
    };

    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = (event) => {
      console.error("[DB] Failed to open IndexedDB:", event.target.error);
      reject(event.target.error);
    };
  });
}

// ─── Generic Transaction Helpers ──────────────────────────────────────────────

/**
 * Wrap an IDB request in a Promise.
 * @param {IDBRequest} request
 * @returns {Promise<any>}
 */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror  = () => reject(request.error);
  });
}

/**
 * Run a read-only transaction on a single store.
 * @param {string} storeName
 * @param {function(IDBObjectStore): IDBRequest|Promise<any>} fn
 * @returns {Promise<any>}
 */
async function readTx(storeName, fn) {
  const db   = await openDB();
  const tx   = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  return fn(store);
}

/**
 * Run a read-write transaction on a single store.
 * @param {string} storeName
 * @param {function(IDBObjectStore): IDBRequest|Promise<any>} fn
 * @returns {Promise<any>}
 */
async function writeTx(storeName, fn) {
  const db   = await openDB();
  const tx   = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  const result = await fn(store);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result);
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

// ─── Notes API ────────────────────────────────────────────────────────────────

/**
 * Save a note record (insert or replace).
 * @param {object} note
 * @returns {Promise<void>}
 */
async function dbPutNote(note) {
  return writeTx("notes", (store) => promisifyRequest(store.put(note)));
}

/**
 * Get all notes for a specific user, sorted newest first.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function dbGetNotesForUser(userId) {
  const db    = await openDB();
  const tx    = db.transaction("notes", "readonly");
  const store = tx.objectStore("notes");
  const index = store.index("user_id");

  return new Promise((resolve, reject) => {
    const results  = [];
    const request  = index.openCursor(IDBKeyRange.only(userId));
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        // Skip soft-deleted records
        if (cursor.value.sync_status !== "pending_delete") {
          results.push(cursor.value);
        }
        cursor.continue();
      } else {
        // Sort newest first
        results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get a single note by ID.
 * @param {string} noteId
 * @returns {Promise<object|undefined>}
 */
async function dbGetNote(noteId) {
  return readTx("notes", (store) => promisifyRequest(store.get(noteId)));
}

/**
 * Delete a note record from local DB.
 * @param {string} noteId
 * @returns {Promise<void>}
 */
async function dbDeleteNote(noteId) {
  return writeTx("notes", (store) => promisifyRequest(store.delete(noteId)));
}

/**
 * Get all notes with a given sync_status.
 * @param {"pending_create"|"pending_update"|"pending_delete"|"synced"} status
 * @returns {Promise<object[]>}
 */
async function dbGetNotesByStatus(status) {
  const db    = await openDB();
  const tx    = db.transaction("notes", "readonly");
  const store = tx.objectStore("notes");
  const index = store.index("sync_status");

  return new Promise((resolve, reject) => {
    const results = [];
    const req     = index.openCursor(IDBKeyRange.only(status));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Note Files API ───────────────────────────────────────────────────────────

/**
 * Save a file attachment record (insert or replace).
 * The `blob` field holds the raw binary content.
 * @param {object} fileRecord
 * @returns {Promise<void>}
 */
async function dbPutFile(fileRecord) {
  return writeTx("note_files", (store) => promisifyRequest(store.put(fileRecord)));
}

/**
 * Get all file attachments for a note.
 * @param {string} noteId
 * @returns {Promise<object[]>}
 */
async function dbGetFilesForNote(noteId) {
  const db    = await openDB();
  const tx    = db.transaction("note_files", "readonly");
  const store = tx.objectStore("note_files");
  const index = store.index("note_id");

  return new Promise((resolve, reject) => {
    const results = [];
    const req     = index.openCursor(IDBKeyRange.only(noteId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.sync_status !== "pending_delete") {
          results.push(cursor.value);
        }
        cursor.continue();
      } else {
        results.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get a single file attachment by ID.
 * @param {string} fileId
 * @returns {Promise<object|undefined>}
 */
async function dbGetFile(fileId) {
  return readTx("note_files", (store) => promisifyRequest(store.get(fileId)));
}

/**
 * Delete a file attachment record from local DB.
 * @param {string} fileId
 * @returns {Promise<void>}
 */
async function dbDeleteFile(fileId) {
  return writeTx("note_files", (store) => promisifyRequest(store.delete(fileId)));
}

/**
 * Get all file attachments for a note that belong to a user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function dbGetFilesByStatus(status) {
  const db    = await openDB();
  const tx    = db.transaction("note_files", "readonly");
  const store = tx.objectStore("note_files");
  const index = store.index("sync_status");

  return new Promise((resolve, reject) => {
    const results = [];
    const req     = index.openCursor(IDBKeyRange.only(status));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete all file attachment records for a note.
 * @param {string} noteId
 * @returns {Promise<void>}
 */
async function dbDeleteFilesForNote(noteId) {
  const db    = await openDB();
  const tx    = db.transaction("note_files", "readwrite");
  const store = tx.objectStore("note_files");
  const index = store.index("note_id");

  return new Promise((resolve, reject) => {
    const req = index.openCursor(IDBKeyRange.only(noteId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ─── Sync Queue API ───────────────────────────────────────────────────────────

/**
 * Enqueue a pending sync operation.
 * @param {"note"|"file"} entity
 * @param {"create"|"update"|"delete"} operation
 * @param {string} entityId
 * @param {object} [payload]
 * @returns {Promise<void>}
 */
async function dbEnqueueSync(entity, operation, entityId, payload = {}) {
  return writeTx("sync_queue", (store) =>
    promisifyRequest(store.add({
      entity,
      operation,
      entity_id:  entityId,
      payload:    JSON.stringify(payload),
      created_at: new Date().toISOString()
    }))
  );
}

/**
 * Get all pending sync queue entries, oldest first.
 * @returns {Promise<object[]>}
 */
async function dbGetSyncQueue() {
  const db    = await openDB();
  const tx    = db.transaction("sync_queue", "readonly");
  const store = tx.objectStore("sync_queue");

  return new Promise((resolve, reject) => {
    const results = [];
    const req     = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Remove a sync queue entry after it has been successfully processed.
 * @param {number} queueEntryId
 * @returns {Promise<void>}
 */
async function dbDequeueSyncEntry(queueEntryId) {
  return writeTx("sync_queue", (store) =>
    promisifyRequest(store.delete(queueEntryId))
  );
}

/**
 * Clear all sync queue entries for a specific entity ID.
 * @param {string} entityId
 * @returns {Promise<void>}
 */
async function dbClearSyncQueueForEntity(entityId) {
  const db    = await openDB();
  const tx    = db.transaction("sync_queue", "readwrite");
  const store = tx.objectStore("sync_queue");
  const index = store.index("entity_id");

  return new Promise((resolve, reject) => {
    const req = index.openCursor(IDBKeyRange.only(entityId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * Clear all entries in sync queue.
 * @returns {Promise<void>}
 */
async function dbClearSyncQueue() {
  return writeTx("sync_queue", (store) => promisifyRequest(store.clear()));
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Delete all local data for a given user (called on logout).
 * Removes their notes, files, and clears the sync queue.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function dbClearUserData(userId) {
  const db = await openDB();

  // Delete user's notes
  await new Promise((resolve, reject) => {
    const tx    = db.transaction("notes", "readwrite");
    const store = tx.objectStore("notes");
    const index = store.index("user_id");
    const req   = index.openCursor(IDBKeyRange.only(userId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
    tx.onerror  = () => reject(tx.error);
  });

  // Delete user's files
  await new Promise((resolve, reject) => {
    const tx    = db.transaction("note_files", "readwrite");
    const store = tx.objectStore("note_files");
    const index = store.index("user_id");
    const req   = index.openCursor(IDBKeyRange.only(userId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
    tx.onerror  = () => reject(tx.error);
  });

  // Clear sync queue
  await dbClearSyncQueue();
}

/**
 * Read a File/Blob as an ArrayBuffer, then convert to Blob for storage.
 * Used when attaching a file from a file input.
 * @param {File} file
 * @returns {Promise<Blob>}
 */
function readFileAsBlob(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(new Blob([e.target.result], { type: file.type }));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Convert a locally stored Blob to an object URL for display.
 * Remember to call URL.revokeObjectURL() when done to avoid memory leaks.
 * @param {Blob} blob
 * @returns {string} objectURL
 */
function blobToObjectURL(blob) {
  return URL.createObjectURL(blob);
}

// Expose all API functions via the global `NotesDB` namespace
window.NotesDB = {
  // Notes
  putNote:            dbPutNote,
  getNotesForUser:    dbGetNotesForUser,
  getNote:            dbGetNote,
  deleteNote:         dbDeleteNote,
  getNotesByStatus:   dbGetNotesByStatus,

  // Files
  putFile:            dbPutFile,
  getFilesForNote:    dbGetFilesForNote,
  getFile:            dbGetFile,
  deleteFile:         dbDeleteFile,
  getFilesByStatus:   dbGetFilesByStatus,
  deleteFilesForNote: dbDeleteFilesForNote,

  // Sync Queue
  enqueueSync:              dbEnqueueSync,
  getSyncQueue:             dbGetSyncQueue,
  dequeueSyncEntry:         dbDequeueSyncEntry,
  clearSyncQueueForEntity:  dbClearSyncQueueForEntity,
  clearSyncQueue:           dbClearSyncQueue,

  // Utility
  clearUserData: dbClearUserData,
  readFileAsBlob,
  blobToObjectURL,
  open: openDB,
};
