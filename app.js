/**
 * app.js — Notes App Logic (Local-First PWA with IndexedDB + Supabase Sync)
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  User Action                                             │
 *   │      ↓                                                   │
 *   │  Write to IndexedDB (always, instant, offline-safe)      │
 *   │      ↓                                                   │
 *   │  Mark as "pending_*" sync status                         │
 *   │      ↓                                                   │
 *   │  Render from IndexedDB (always current)                  │
 *   │      ↓                                                   │
 *   │  Background Sync → Push to Supabase when online          │
 *   │      ↓                                                   │
 *   │  Mark as "synced", update local IDs from Supabase        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Features:
 *   - IndexedDB-first: all CRUD works offline, notes & files persisted locally
 *   - Local file blobs: images/PDFs stored as binary Blobs in IDB, displayed
 *     via Object URLs without any network round-trip
 *   - Background Sync: window.ononline / periodic polling pushes pending
 *     changes to Supabase without blocking the UI
 *   - Supabase Auth: sign up, sign in, Google OAuth, sign out (unchanged)
 *   - On login: pulls latest Supabase data and merges into local IDB
 *   - XSS protection: textContent everywhere, never innerHTML for user data
 */

// ============================================================================
// 1. Supabase Client Initialization
// ============================================================================

if (typeof supabase === "undefined") {
  console.error("Supabase library not loaded. Check the CDN script tag in index.html.");
}

const normalizedSupabaseUrl = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");
const supabaseClient = supabase.createClient(normalizedSupabaseUrl, SUPABASE_ANON_KEY);


// ============================================================================
// 2. DOM Elements & State Variables
// ============================================================================

const appContainer      = document.getElementById("app-container");
const authView          = document.getElementById("auth-view");
const dashboardView     = document.getElementById("dashboard-view");
const messageBanner     = document.getElementById("message-banner");

const tabLogin          = document.getElementById("tab-login");
const tabSignup         = document.getElementById("tab-signup");
const switchToSignupLink= document.getElementById("switch-to-signup");
const switchToLoginLink = document.getElementById("switch-to-login");

const loginForm         = document.getElementById("login-form");
const signupForm        = document.getElementById("signup-form");
const loginEmailInput   = document.getElementById("login-email");
const loginPasswordInput= document.getElementById("login-password");
const signupEmailInput  = document.getElementById("signup-email");
const signupPasswordInput= document.getElementById("signup-password");
const loginSubmitBtn    = document.getElementById("login-submit-btn");
const signupSubmitBtn   = document.getElementById("signup-submit-btn");

const googleLoginBtn    = document.getElementById("google-login-btn");
const googleBtnText     = document.getElementById("google-btn-text");

const loggedInUserEmail = document.getElementById("logged-in-user-email");
const logoutBtn         = document.getElementById("logout-btn");

const addNoteForm       = document.getElementById("add-note-form");
const noteTitleInput    = document.getElementById("note-title-input");
const noteContentInput  = document.getElementById("note-content-input");
const addNoteSubmitBtn  = document.getElementById("add-note-submit-btn");

const notesLoading      = document.getElementById("notes-loading");
const notesEmpty        = document.getElementById("notes-empty");
const notesList         = document.getElementById("notes-list");
const notesCountBadge   = document.getElementById("notes-count-badge");

// App state
let userNotes              = [];
let currentUserId          = null;
let isNotesLoaded          = false;
let isLoadingNotes         = false;
let currentlyEditingNoteId = null;
let messageTimeoutId       = null;
let messageFadeTimeoutId   = null;

// Sync state
let isSyncing              = false;
let syncIntervalId         = null;

// Supabase storage constants
const STORAGE_BUCKET    = "note-files";
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "pdf"];
const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/png", "image/webp", "application/pdf"
];


// ============================================================================
// 3. UI Helper Functions
// ============================================================================

function showMessage(content, type = "error", isHtml = false, duration = null) {
  if (messageTimeoutId)     { clearTimeout(messageTimeoutId);     messageTimeoutId     = null; }
  if (messageFadeTimeoutId) { clearTimeout(messageFadeTimeoutId); messageFadeTimeoutId = null; }

  messageBanner.classList.remove("fade-out");

  if (isHtml) {
    messageBanner.innerHTML = content;
  } else {
    messageBanner.textContent = content;
  }
  messageBanner.className = `message-banner ${type}`;

  const autoDismissDelay = duration !== null ? duration : (type === "success" ? 3200 : 6000);

  if (autoDismissDelay > 0) {
    messageFadeTimeoutId = setTimeout(() => {
      messageBanner.classList.add("fade-out");
    }, autoDismissDelay - 300);
    messageTimeoutId = setTimeout(() => clearMessage(), autoDismissDelay);
  }
}

function clearMessage() {
  if (messageTimeoutId)     { clearTimeout(messageTimeoutId);     messageTimeoutId     = null; }
  if (messageFadeTimeoutId) { clearTimeout(messageFadeTimeoutId); messageFadeTimeoutId = null; }
  messageBanner.classList.remove("fade-out");
  messageBanner.innerHTML   = "";
  messageBanner.className   = "message-banner hidden";
}

function setButtonLoading(button, isLoading, defaultText, loadingText) {
  button.disabled    = isLoading;
  button.textContent = isLoading ? loadingText : defaultText;
}

function setActiveTab(formName) {
  clearMessage();
  if (formName === "login") {
    loginForm.classList.remove("hidden");
    signupForm.classList.add("hidden");
    tabLogin.classList.add("active");   tabLogin.setAttribute("aria-selected", "true");
    tabSignup.classList.remove("active"); tabSignup.setAttribute("aria-selected", "false");
    loginEmailInput.focus();
  } else {
    signupForm.classList.remove("hidden");
    loginForm.classList.add("hidden");
    tabSignup.classList.add("active");  tabSignup.setAttribute("aria-selected", "true");
    tabLogin.classList.remove("active"); tabLogin.setAttribute("aria-selected", "false");
    signupEmailInput.focus();
  }
}

function formatNoteDate(timestamp) {
  if (!timestamp) return "Just now";
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return "Recently";
    return date.toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  } catch { return "Recently"; }
}

/** Show a small sync status chip in the UI */
function showSyncStatus(text, isError = false) {
  let chip = document.getElementById("sync-status-chip");
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "sync-status-chip";
    chip.className = "sync-status-chip";
    document.body.appendChild(chip);
  }
  chip.textContent = text;
  chip.className   = `sync-status-chip ${isError ? "sync-error" : "sync-info"}`;
  chip.classList.remove("hidden");
  clearTimeout(chip._timeout);
  chip._timeout = setTimeout(() => chip.classList.add("hidden"), 4000);
}

function updateAuthUI(user) {
  const newUserId = user ? user.id : null;
  if (user) {
    authView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    appContainer.classList.add("expanded");
    loggedInUserEmail.textContent = user.email || "Unknown user";

    if (newUserId !== currentUserId || !isNotesLoaded) {
      currentUserId = newUserId;
      isNotesLoaded = true;
      loadNotes();
      startBackgroundSync();
    }
  } else {
    stopBackgroundSync();
    if (currentUserId) {
      NotesDB.clearUserData(currentUserId).catch(console.warn);
    }
    currentUserId          = null;
    isNotesLoaded          = false;
    currentlyEditingNoteId = null;

    dashboardView.classList.add("hidden");
    authView.classList.remove("hidden");
    appContainer.classList.remove("expanded");
    loggedInUserEmail.textContent = "";

    userNotes = [];
    notesList.innerHTML  = "";
    notesCountBadge.textContent = "0";
  }
}


// ============================================================================
// 4. File Helpers
// ============================================================================

function getFileExtension(filename) {
  if (!filename || typeof filename !== "string") return "";
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024)        return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isImageFile(mimeType, filename) {
  if (mimeType && mimeType.startsWith("image/")) return true;
  return ["jpg", "jpeg", "png", "webp"].includes(getFileExtension(filename));
}

function validateAttachmentFile(file) {
  if (!file) return { valid: false, error: "No file selected." };
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { valid: false, error: `"${file.name}" exceeds 5 MB (${formatFileSize(file.size)}).` };
  }
  const ext           = getFileExtension(file.name);
  const isAllowedExt  = ALLOWED_EXTENSIONS.includes(ext);
  const isAllowedMime = ALLOWED_MIME_TYPES.includes(file.type) || isAllowedExt;
  if (!isAllowedExt || !isAllowedMime) {
    return { valid: false, error: `Invalid file type for "${file.name}". Only JPG, PNG, WebP and PDF allowed.` };
  }
  return { valid: true };
}


// ============================================================================
// 5. Load & Render Notes (from IndexedDB)
// ============================================================================

/**
 * Load all notes for the current user from IndexedDB (always instant, offline-safe).
 * After local render, trigger a background pull from Supabase if online.
 */
async function loadNotes() {
  if (isLoadingNotes || !currentUserId) return;
  isLoadingNotes = true;

  if (userNotes.length === 0) {
    notesLoading.classList.remove("hidden");
    notesEmpty.classList.add("hidden");
    notesList.innerHTML = "";
  }

  try {
    // 1. Load from IndexedDB first (works offline)
    const localNotes = await NotesDB.getNotesForUser(currentUserId);

    // Attach local files to each note
    for (const note of localNotes) {
      note.files = await NotesDB.getFilesForNote(note.id);
    }

    userNotes = localNotes;

    if (!currentlyEditingNoteId) {
      await renderNotesList();
    } else {
      notesCountBadge.textContent = userNotes.length;
    }

    // 2. If online, pull fresh data from Supabase and merge
    if (navigator.onLine) {
      await pullFromSupabase();
    }
  } catch (err) {
    console.error("Error loading notes:", err);
    showMessage("Failed to load notes from local storage.", "error");
  } finally {
    isLoadingNotes = false;
    notesLoading.classList.add("hidden");
  }
}

async function renderNotesList() {
  notesList.innerHTML = "";
  notesCountBadge.textContent = userNotes.length;

  if (userNotes.length === 0) {
    notesEmpty.classList.remove("hidden");
  } else {
    notesEmpty.classList.add("hidden");
    for (const note of userNotes) {
      const noteElement = await createNoteElement(note);
      notesList.appendChild(noteElement);
    }
  }
}


// ============================================================================
// 6. Note Card DOM Rendering
// ============================================================================

async function createNoteElement(note) {
  const card = document.createElement("article");
  card.className  = "card note-card";
  card.dataset.id = note.id;

  // Show a subtle "pending sync" badge on unsynced notes
  if (note.sync_status && note.sync_status !== "synced") {
    card.classList.add("note-pending-sync");
  }

  await renderNoteView(card, note);
  return card;
}

async function renderNoteView(card, note) {
  card.innerHTML = "";

  // Header: title + date
  const header  = document.createElement("div");
  header.className = "note-header";

  const titleEl = document.createElement("h3");
  titleEl.className   = "note-title";
  titleEl.textContent = note.title; // textContent — XSS-safe

  const dateEl = document.createElement("time");
  dateEl.className   = "note-date";
  const lastEdited   = note.updated_at || note.created_at;
  dateEl.textContent = `Last edited: ${formatNoteDate(lastEdited)}`;

  // "Pending sync" indicator
  if (note.sync_status && note.sync_status !== "synced") {
    const syncBadge = document.createElement("span");
    syncBadge.className   = "sync-pending-badge";
    syncBadge.title       = "Saved locally — will sync when online";
    syncBadge.textContent = "● Offline";
    header.appendChild(syncBadge);
  }

  header.appendChild(titleEl);
  header.appendChild(dateEl);
  card.appendChild(header);

  // Content
  if (note.content && note.content.trim()) {
    const contentEl  = document.createElement("p");
    contentEl.className   = "note-content";
    contentEl.textContent = note.content; // textContent — XSS-safe
    card.appendChild(contentEl);
  }

  // Attachments
  const attachmentsContainer = document.createElement("div");
  attachmentsContainer.className = "note-attachments";
  card.appendChild(attachmentsContainer);
  await renderNoteAttachments(attachmentsContainer, note);

  // Action Buttons
  const actions    = document.createElement("div");
  actions.className = "note-actions";

  // Left: Attach button + hidden file input
  const actionsLeft = document.createElement("div");
  actionsLeft.className = "note-actions-left";

  const fileInput   = document.createElement("input");
  fileInput.type    = "file";
  fileInput.accept  = ".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf";
  fileInput.style.display = "none";

  const attachBtn   = document.createElement("button");
  attachBtn.type    = "button";
  attachBtn.className = "btn btn-sm btn-attach";
  attachBtn.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
    </svg>
    <span>Attach file</span>
  `;

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    await handleAttachFile(note, fileInput, attachBtn, attachmentsContainer);
  });

  actionsLeft.appendChild(fileInput);
  actionsLeft.appendChild(attachBtn);
  actions.appendChild(actionsLeft);

  // Right: Edit and Delete
  const editBtn = document.createElement("button");
  editBtn.type      = "button";
  editBtn.className = "btn btn-secondary btn-sm";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => renderNoteEditForm(card, note));

  const deleteBtn = document.createElement("button");
  deleteBtn.type      = "button";
  deleteBtn.className = "btn btn-danger btn-sm";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => handleDeleteNote(note.id, deleteBtn));

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  card.appendChild(actions);
}

/**
 * Render attachments from local IndexedDB blobs (no network needed).
 */
async function renderNoteAttachments(container, note) {
  container.innerHTML = "";
  const files = note.files || [];

  if (files.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");

  const header = document.createElement("div");
  header.className = "attachments-header";
  header.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
    </svg>
    <span>Attachments (${files.length})</span>
  `;
  container.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "attachments-grid";
  container.appendChild(grid);

  for (const file of files) {
    const itemEl = await createAttachmentItem(note, file, container);
    if (itemEl) grid.appendChild(itemEl);
  }
}

/**
 * Create an attachment card, using local blob URL for display (works offline).
 * Falls back to signed Supabase URL if blob is not available locally.
 */
async function createAttachmentItem(note, file, container) {
  // Resolve display URL: prefer local blob, fall back to Supabase signed URL
  let displayUrl = null;
  let objectUrl  = null; // track for cleanup

  if (file.blob) {
    objectUrl  = NotesDB.blobToObjectURL(file.blob);
    displayUrl = objectUrl;
  } else if (file.file_path && navigator.onLine) {
    displayUrl = await getSignedAttachmentUrl(file.file_path);
  }

  if (isImageFile(file.mime_type, file.file_name)) {
    const imgCard = document.createElement("div");
    imgCard.className = "attachment-img-card";

    const delBtn = document.createElement("button");
    delBtn.type      = "button";
    delBtn.className = "attachment-delete-overlay";
    delBtn.title     = "Delete attachment";
    delBtn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      await handleDeleteAttachment(note, file, imgCard, container);
    });

    const imgLink = document.createElement("a");
    imgLink.className  = "attachment-img-link";
    imgLink.target     = "_blank";
    imgLink.rel        = "noopener noreferrer";
    if (displayUrl) imgLink.href = displayUrl;

    const img    = document.createElement("img");
    img.className = "attachment-img-thumb";
    if (displayUrl) img.src = displayUrl;
    img.alt     = file.file_name;
    img.loading = "lazy";
    imgLink.appendChild(img);

    const nameSpan = document.createElement("span");
    nameSpan.className   = "attachment-img-name";
    nameSpan.textContent = file.file_name; // textContent — XSS-safe
    nameSpan.title       = file.file_name;

    imgCard.appendChild(delBtn);
    imgCard.appendChild(imgLink);
    imgCard.appendChild(nameSpan);
    return imgCard;

  } else {
    // PDF card
    const pdfCard = document.createElement("div");
    pdfCard.className = "attachment-pdf-card";

    const pdfLink = document.createElement("a");
    pdfLink.className = "attachment-pdf-link";
    pdfLink.target    = "_blank";
    pdfLink.rel       = "noopener noreferrer";
    if (displayUrl) pdfLink.href = displayUrl;

    pdfLink.innerHTML = `
      <svg width="16" height="16" class="attachment-pdf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
      </svg>`;

    const nameSpan = document.createElement("span");
    nameSpan.className   = "attachment-pdf-name";
    nameSpan.textContent = file.file_name; // textContent — XSS-safe
    nameSpan.title       = file.file_name;
    pdfLink.appendChild(nameSpan);

    if (file.size_bytes) {
      const sizeSpan = document.createElement("span");
      sizeSpan.className   = "attachment-pdf-size";
      sizeSpan.textContent = `(${formatFileSize(file.size_bytes)})`;
      pdfLink.appendChild(sizeSpan);
    }

    // "Local only" badge if not yet synced to cloud
    if (!file.file_path || file.sync_status === "pending_upload") {
      const localBadge = document.createElement("span");
      localBadge.className   = "attachment-local-badge";
      localBadge.title       = "Stored locally — will upload when online";
      localBadge.textContent = "● Local";
      pdfLink.appendChild(localBadge);
    }

    const delBtn = document.createElement("button");
    delBtn.type      = "button";
    delBtn.className = "attachment-pdf-delete";
    delBtn.title     = "Delete attachment";
    delBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
    delBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      await handleDeleteAttachment(note, file, pdfCard, container);
    });

    pdfCard.appendChild(pdfLink);
    pdfCard.appendChild(delBtn);
    return pdfCard;
  }
}


// ============================================================================
// 7. Notes CRUD — Write to IndexedDB First, Queue Sync
// ============================================================================

/**
 * Add a new note — saves locally first, queues Supabase sync.
 */
async function handleAddNote(event) {
  event.preventDefault();
  clearMessage();

  const title   = noteTitleInput.value.trim();
  const content = noteContentInput.value.trim();

  if (!title) {
    showMessage("Please enter a note title.", "error");
    noteTitleInput.focus();
    return;
  }

  setButtonLoading(addNoteSubmitBtn, true, "Add Note", "Adding Note...");

  try {
    const now    = new Date().toISOString();
    const noteId = generateUUID();

    const newNote = {
      id:          noteId,
      user_id:     currentUserId,
      title:       title,
      content:     content,
      created_at:  now,
      updated_at:  now,
      sync_status: "pending_create",
      files:       []
    };

    // 1. Save to IndexedDB immediately
    await NotesDB.putNote(newNote);

    // 2. Queue background sync
    await NotesDB.enqueueSync("note", "create", noteId, { title, content });

    // 3. Update in-memory list and render
    userNotes.unshift(newNote);
    await renderNotesList();

    noteTitleInput.value  = "";
    noteContentInput.value = "";
    showMessage("Note saved!", "success");

    // 4. Try immediate sync if online
    if (navigator.onLine) triggerSync();

  } catch (err) {
    console.error("Error adding note:", err);
    showMessage(err.message || "Failed to save note.", "error");
  } finally {
    setButtonLoading(addNoteSubmitBtn, false, "Add Note", "Adding Note...");
  }
}

/**
 * Inline note edit form
 */
function renderNoteEditForm(card, note) {
  currentlyEditingNoteId = note.id;
  card.innerHTML = "";

  const form = document.createElement("form");
  form.className = "edit-note-form";

  const titleInput = document.createElement("input");
  titleInput.type        = "text";
  titleInput.value       = note.title;
  titleInput.required    = true;
  titleInput.placeholder = "Note title...";

  const contentTextarea  = document.createElement("textarea");
  contentTextarea.rows   = 3;
  contentTextarea.value  = note.content || "";
  contentTextarea.placeholder = "Write your note here...";

  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); contentTextarea.focus(); }
  });

  const actions   = document.createElement("div");
  actions.className = "edit-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type      = "button";
  cancelBtn.className = "btn btn-secondary btn-sm";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    currentlyEditingNoteId = null;
    clearMessage();
    renderNoteView(card, note);
  });

  const saveBtn = document.createElement("button");
  saveBtn.type      = "submit";
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "Save";

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  form.appendChild(titleInput);
  form.appendChild(contentTextarea);
  form.appendChild(actions);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleSaveNoteEdit(card, note, titleInput.value, contentTextarea.value, saveBtn);
  });

  card.appendChild(form);
  titleInput.focus();
}

/**
 * Save edited note — write to IndexedDB first, queue sync.
 */
async function handleSaveNoteEdit(card, note, newTitle, newContent, saveBtn) {
  clearMessage();
  const trimmedTitle   = newTitle.trim();
  const trimmedContent = newContent.trim();

  if (!trimmedTitle) {
    showMessage("Note title cannot be empty.", "error");
    return;
  }

  setButtonLoading(saveBtn, true, "Save", "Saving...");

  try {
    const now = new Date().toISOString();

    // Determine sync_status: if note is not yet created on server, keep pending_create
    const prevStatus = note.sync_status || "synced";
    const newStatus  = prevStatus === "pending_create" ? "pending_create" : "pending_update";

    const updatedNote = {
      ...note,
      title:       trimmedTitle,
      content:     trimmedContent,
      updated_at:  now,
      sync_status: newStatus
    };

    // 1. Write to IndexedDB
    await NotesDB.putNote(updatedNote);

    // 2. Queue sync (only if not already queued as pending_create)
    if (newStatus === "pending_update") {
      await NotesDB.clearSyncQueueForEntity(note.id);
      await NotesDB.enqueueSync("note", "update", note.id, {
        title: trimmedTitle, content: trimmedContent, updated_at: now
      });
    }

    // 3. Update in-memory cache
    Object.assign(note, updatedNote);
    const idx = userNotes.findIndex((n) => n.id === note.id);
    if (idx !== -1) userNotes[idx] = { ...note };

    currentlyEditingNoteId = null;
    showMessage("Note updated!", "success");
    await renderNoteView(card, note);

    if (navigator.onLine) triggerSync();

  } catch (err) {
    console.error("Error saving note:", err);
    showMessage(err.message || "Failed to update note.", "error");
    setButtonLoading(saveBtn, false, "Save", "Saving...");
  }
}

/**
 * Delete a note — soft-delete in IndexedDB, queue removal, purge locally.
 */
async function handleDeleteNote(noteId, deleteBtn) {
  clearMessage();
  const confirmed = window.confirm("Delete this note and all its attachments?");
  if (!confirmed) return;

  if (currentlyEditingNoteId === noteId) currentlyEditingNoteId = null;

  setButtonLoading(deleteBtn, true, "Delete", "Deleting...");

  try {
    const note = userNotes.find((n) => n.id === noteId);

    // 1. Mark files as pending_delete and queue their cloud removal
    const localFiles = note ? (note.files || []) : await NotesDB.getFilesForNote(noteId);
    for (const file of localFiles) {
      if (file.sync_status === "synced" && file.file_path) {
        // Need to delete from Supabase storage too
        const updated = { ...file, sync_status: "pending_delete" };
        await NotesDB.putFile(updated);
        await NotesDB.enqueueSync("file", "delete", file.id, {
          file_path: file.file_path, note_id: noteId
        });
      } else {
        // Never synced — just delete locally
        await NotesDB.deleteFile(file.id);
      }
    }

    // 2. Mark note as pending_delete (or delete immediately if never synced)
    if (note && note.sync_status === "pending_create") {
      // Was never synced — delete locally without queuing
      await NotesDB.deleteNote(noteId);
      await NotesDB.clearSyncQueueForEntity(noteId);
    } else {
      const deletedNote = { ...(note || { id: noteId }), sync_status: "pending_delete" };
      await NotesDB.putNote(deletedNote);
      await NotesDB.clearSyncQueueForEntity(noteId);
      await NotesDB.enqueueSync("note", "delete", noteId, {});
    }

    // 3. Remove from in-memory list and re-render
    userNotes = userNotes.filter((n) => n.id !== noteId);
    await renderNotesList();

    showMessage("Note deleted!", "success");

    if (navigator.onLine) triggerSync();

  } catch (err) {
    console.error("Error deleting note:", err);
    showMessage(err.message || "Failed to delete note.", "error");
    setButtonLoading(deleteBtn, false, "Delete", "Deleting...");
  }
}


// ============================================================================
// 8. File Attachments — Store Blob Locally, Queue Upload
// ============================================================================

/**
 * Attach a file to a note:
 *   1. Read the file into a binary Blob via FileReader
 *   2. Store the Blob in IndexedDB against the note
 *   3. Display immediately from the local Blob URL
 *   4. Queue upload to Supabase Storage for background sync
 */
async function handleAttachFile(note, fileInput, attachBtn, attachmentsContainer) {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  clearMessage();

  const validation = validateAttachmentFile(file);
  if (!validation.valid) {
    showMessage(validation.error, "error");
    fileInput.value = "";
    return;
  }

  if (!currentUserId) {
    showMessage("Please log in to attach files.", "error");
    fileInput.value = "";
    return;
  }

  // Show "Saving…" on the button — this is local so it's instant
  setButtonLoading(attachBtn, true, "Attach file", "Saving...");

  try {
    // 1. Read file into a Blob
    const blob      = await NotesDB.readFileAsBlob(file);
    const fileId    = generateUUID();
    const extension = getFileExtension(file.name);
    const now       = new Date().toISOString();

    const fileRecord = {
      id:          fileId,
      note_id:     note.id,
      user_id:     currentUserId,
      file_name:   file.name,
      mime_type:   file.type || "application/octet-stream",
      size_bytes:  file.size,
      blob:        blob,         // ← raw binary stored in IDB
      file_path:   "",           // set after Supabase upload
      created_at:  now,
      sync_status: "pending_upload"
    };

    // 2. Save to IndexedDB
    await NotesDB.putFile(fileRecord);

    // 3. Queue upload
    await NotesDB.enqueueSync("file", "create", fileId, {
      note_id:    note.id,
      file_name:  file.name,
      mime_type:  file.type || "application/octet-stream",
      size_bytes: file.size,
      extension:  extension
    });

    // 4. Update in-memory note.files and re-render attachments
    if (!note.files) note.files = [];
    note.files.push(fileRecord);

    const cached = userNotes.find((n) => n.id === note.id);
    if (cached) cached.files = note.files;

    await renderNoteAttachments(attachmentsContainer, note);

    showMessage(`"${file.name}" saved locally!`, "success");

    if (navigator.onLine) triggerSync();

  } catch (err) {
    console.error("Error attaching file:", err);
    showMessage(err.message || "Failed to attach file.", "error");
  } finally {
    fileInput.value = "";
    setButtonLoading(attachBtn, false, "Attach file", "Saving...");
  }
}

/**
 * Delete an attachment — remove from IDB immediately, queue cloud deletion.
 */
async function handleDeleteAttachment(note, file, itemElement, container) {
  clearMessage();
  const confirmed = window.confirm(`Delete attachment "${file.file_name}"?`);
  if (!confirmed) return;

  itemElement.style.opacity       = "0.45";
  itemElement.style.pointerEvents = "none";

  try {
    if (file.sync_status === "pending_upload") {
      // Never reached Supabase — just remove locally
      await NotesDB.deleteFile(file.id);
      await NotesDB.clearSyncQueueForEntity(file.id);
    } else {
      // Was synced — queue deletion on Supabase
      const updated = { ...file, sync_status: "pending_delete" };
      await NotesDB.putFile(updated);
      await NotesDB.clearSyncQueueForEntity(file.id);
      await NotesDB.enqueueSync("file", "delete", file.id, { file_path: file.file_path });
    }

    // Update in-memory and re-render
    note.files = (note.files || []).filter((f) => f.id !== file.id);
    const cached = userNotes.find((n) => n.id === note.id);
    if (cached) cached.files = note.files;

    await renderNoteAttachments(container, note);
    showMessage("Attachment removed!", "success");

    if (navigator.onLine) triggerSync();

  } catch (err) {
    console.error("Error deleting attachment:", err);
    showMessage(err.message || "Failed to delete attachment.", "error");
    itemElement.style.opacity       = "1";
    itemElement.style.pointerEvents = "auto";
  }
}


// ============================================================================
// 9. Supabase Signed URL Helper (online only)
// ============================================================================

async function getSignedAttachmentUrl(filePath) {
  try {
    const { data, error } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(filePath, 3600);
    if (error || !data) return null;
    return data.signedUrl;
  } catch { return null; }
}


// ============================================================================
// 10. Background Sync — Push Local Changes to Supabase
// ============================================================================

/**
 * Process the sync queue: for each pending entry, push to Supabase.
 * Safe to call multiple times — guarded by isSyncing flag.
 */
async function triggerSync() {
  if (isSyncing || !currentUserId || !navigator.onLine) return;
  isSyncing = true;

  try {
    const queue = await NotesDB.getSyncQueue();
    if (queue.length === 0) { isSyncing = false; return; }

    showSyncStatus(`Syncing ${queue.length} change${queue.length > 1 ? "s" : ""}…`);

    for (const entry of queue) {
      try {
        await processSyncEntry(entry);
        await NotesDB.dequeueSyncEntry(entry.id);
      } catch (err) {
        console.warn(`[Sync] Failed to process entry ${entry.id}:`, err);
        // Don't dequeue — will retry next time
      }
    }

    showSyncStatus("All changes synced ✓");
    // Reload from Supabase to get server-assigned IDs
    await pullFromSupabase();

  } catch (err) {
    console.error("[Sync] Sync error:", err);
    showSyncStatus("Sync failed — will retry", true);
  } finally {
    isSyncing = false;
  }
}

/**
 * Process a single sync queue entry.
 * @param {object} entry
 */
async function processSyncEntry(entry) {
  const payload = JSON.parse(entry.payload || "{}");

  if (entry.entity === "note") {
    switch (entry.operation) {
      case "create": await syncCreateNote(entry.entity_id, payload); break;
      case "update": await syncUpdateNote(entry.entity_id, payload); break;
      case "delete": await syncDeleteNote(entry.entity_id);          break;
    }
  } else if (entry.entity === "file") {
    switch (entry.operation) {
      case "create": await syncUploadFile(entry.entity_id, payload); break;
      case "delete": await syncDeleteFile(entry.entity_id, payload); break;
    }
  }
}

/** Push a new note to Supabase. */
async function syncCreateNote(localId, payload) {
  const { data, error } = await supabaseClient
    .from("notes")
    .insert([{ title: payload.title, content: payload.content }])
    .select()
    .single();

  if (error) throw error;

  // Remap local UUID to Supabase ID and mark synced
  const localNote = await NotesDB.getNote(localId);
  if (localNote) {
    // Store the Supabase-assigned ID mapping in the record
    // We update the local note to use the Supabase ID
    await NotesDB.deleteNote(localId);

    // Also remap any files that reference this local note ID
    const localFiles = await NotesDB.getFilesForNote(localId);
    for (const f of localFiles) {
      await NotesDB.putFile({ ...f, note_id: data.id });
      await NotesDB.deleteFile(f.id);
      // Re-add with updated note_id
      await NotesDB.putFile({ ...f, note_id: data.id, id: f.id });
    }

    await NotesDB.putNote({
      ...localNote,
      id:          data.id,
      created_at:  data.created_at,
      updated_at:  data.updated_at,
      sync_status: "synced"
    });
  }
}

/** Push a note update to Supabase. */
async function syncUpdateNote(noteId, payload) {
  const { error } = await supabaseClient
    .from("notes")
    .update({ title: payload.title, content: payload.content, updated_at: payload.updated_at })
    .eq("id", noteId);

  if (error) throw error;

  const localNote = await NotesDB.getNote(noteId);
  if (localNote && localNote.sync_status !== "pending_create") {
    await NotesDB.putNote({ ...localNote, sync_status: "synced" });
  }
}

/** Delete a note from Supabase, then remove local pending record. */
async function syncDeleteNote(noteId) {
  const { error } = await supabaseClient
    .from("notes")
    .delete()
    .eq("id", noteId);

  if (error && !error.message.includes("No rows")) throw error;

  // Hard-delete the local record
  await NotesDB.deleteNote(noteId);
  await NotesDB.deleteFilesForNote(noteId);
}

/** Upload a local file blob to Supabase Storage and register in note_files table. */
async function syncUploadFile(fileId, payload) {
  const fileRecord = await NotesDB.getFile(fileId);
  if (!fileRecord || !fileRecord.blob) {
    console.warn(`[Sync] File ${fileId} blob not found — skipping upload`);
    return;
  }

  const extension   = payload.extension || getFileExtension(payload.file_name);
  const randomUuid  = generateUUID();
  const storagePath = `${currentUserId}/${payload.note_id}/${randomUuid}.${extension}`;

  // 1. Upload blob to Supabase Storage
  const { error: uploadError } = await supabaseClient.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, fileRecord.blob, {
      contentType: payload.mime_type || "application/octet-stream",
      upsert: false
    });

  if (uploadError) throw uploadError;

  // 2. Insert row into note_files table
  const { data: insertedRow, error: insertError } = await supabaseClient
    .from("note_files")
    .insert([{
      note_id:    payload.note_id,
      file_path:  storagePath,
      file_name:  payload.file_name,
      mime_type:  payload.mime_type,
      size_bytes: payload.size_bytes
    }])
    .select()
    .single();

  if (insertError) {
    // Rollback storage upload
    await supabaseClient.storage.from(STORAGE_BUCKET).remove([storagePath]);
    throw insertError;
  }

  // 3. Update local record with server path and mark synced
  await NotesDB.putFile({
    ...fileRecord,
    file_path:   storagePath,
    sync_status: "synced"
  });
}

/** Delete a file from Supabase Storage and note_files table. */
async function syncDeleteFile(fileId, payload) {
  if (payload.file_path) {
    await supabaseClient.storage.from(STORAGE_BUCKET).remove([payload.file_path]);
  }
  await supabaseClient.from("note_files").delete().eq("id", fileId);
  await NotesDB.deleteFile(fileId);
}

/**
 * Pull latest notes and files from Supabase and merge into IndexedDB.
 * Called after a successful sync or on first online login.
 */
async function pullFromSupabase() {
  if (!currentUserId || !navigator.onLine) return;

  try {
    const { data: notesData, error: notesError } = await supabaseClient
      .from("notes")
      .select("*")
      .order("created_at", { ascending: false });

    if (notesError) throw notesError;

    const { data: filesData } = await supabaseClient
      .from("note_files")
      .select("*")
      .order("created_at", { ascending: true });

    const serverFiles = filesData || [];

    // Merge server notes into IDB
    for (const serverNote of (notesData || [])) {
      const local = await NotesDB.getNote(serverNote.id);
      // Only overwrite if not pending local changes
      if (!local || local.sync_status === "synced") {
        await NotesDB.putNote({
          ...serverNote,
          user_id:     currentUserId,
          sync_status: "synced"
        });
      }
    }

    // Merge server files into IDB (preserve local blob)
    for (const serverFile of serverFiles) {
      const local = await NotesDB.getFile(serverFile.id);
      if (!local || local.sync_status === "synced") {
        await NotesDB.putFile({
          ...serverFile,
          user_id:     currentUserId,
          blob:        (local && local.blob) ? local.blob : null,
          sync_status: "synced"
        });
      }
    }

    // Refresh in-memory list from IDB
    const freshNotes = await NotesDB.getNotesForUser(currentUserId);
    for (const note of freshNotes) {
      note.files = await NotesDB.getFilesForNote(note.id);
    }
    userNotes = freshNotes;

    if (!currentlyEditingNoteId) {
      await renderNotesList();
    }
  } catch (err) {
    console.warn("[Sync] Pull from Supabase failed:", err.message);
  }
}

/** Start periodic background sync (every 30 seconds while logged in). */
function startBackgroundSync() {
  stopBackgroundSync();
  syncIntervalId = setInterval(() => {
    if (navigator.onLine) triggerSync();
  }, 30_000);
}

function stopBackgroundSync() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

// Listen for the browser coming back online
window.addEventListener("online", () => {
  showSyncStatus("Back online — syncing…");
  triggerSync();
});

window.addEventListener("offline", () => {
  showSyncStatus("You are offline — changes saved locally", true);
});


// ============================================================================
// 11. Supabase Authentication Handlers (unchanged from original)
// ============================================================================

async function handleResendConfirmation(email) {
  if (!email) { showMessage("Please enter your email above first.", "error"); return; }
  showMessage("Sending a new confirmation email...", "success");
  try {
    const resendOptions = {};
    if (window.location.protocol.startsWith("http")) {
      resendOptions.emailRedirectTo = window.location.origin + window.location.pathname;
    }
    const { error } = await supabaseClient.auth.resend({
      type: "signup", email, options: resendOptions
    });
    if (error) throw error;
    showMessage("Confirmation email sent! Check your inbox (and spam folder).", "success");
  } catch (err) {
    showMessage(err.message || "Could not resend confirmation email.", "error");
  }
}

async function handleSignUp(event) {
  event.preventDefault();
  clearMessage();
  const email    = signupEmailInput.value.trim();
  const password = signupPasswordInput.value;

  if (!email || !password)  { showMessage("Please provide both email and password.", "error"); return; }
  if (password.length < 6) { showMessage("Password must be at least 6 characters.", "error"); return; }

  setButtonLoading(signupSubmitBtn, true, "Create Account", "Creating Account...");
  try {
    const signUpOptions = {};
    if (window.location.protocol.startsWith("http")) {
      signUpOptions.emailRedirectTo = window.location.origin + window.location.pathname;
    }
    const { data, error } = await supabaseClient.auth.signUp({ email, password, options: signUpOptions });
    if (error) throw error;
    if (data.user && !data.session) {
      showMessage("Registration successful! Check your email to confirm before logging in.", "success");
      setActiveTab("login");
      loginEmailInput.value    = email;
      loginPasswordInput.value = "";
    } else if (data.session) {
      showMessage("Account created and logged in!", "success");
    }
  } catch (err) {
    showMessage(err.message || "Failed to sign up. Please try again.", "error");
  } finally {
    setButtonLoading(signupSubmitBtn, false, "Create Account", "Creating Account...");
  }
}

async function handleLogin(event) {
  event.preventDefault();
  clearMessage();
  const email    = loginEmailInput.value.trim();
  const password = loginPasswordInput.value;

  if (!email || !password) { showMessage("Please enter both email and password.", "error"); return; }

  setButtonLoading(loginSubmitBtn, true, "Log In", "Logging in...");
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    showMessage("Logged in successfully!", "success");
  } catch (err) {
    const msg = err.message || "";
    if (msg.toLowerCase().includes("email not confirmed")) {
      showMessage(
        `Email not confirmed. <a href="#" id="resend-confirmation-link" class="link">Resend confirmation email</a>.`,
        "error", true
      );
      const link = document.getElementById("resend-confirmation-link");
      if (link) link.addEventListener("click", (e) => { e.preventDefault(); handleResendConfirmation(email); });
    } else {
      showMessage(msg || "Failed to log in. Check your credentials.", "error");
    }
  } finally {
    setButtonLoading(loginSubmitBtn, false, "Log In", "Logging in...");
  }
}

async function handleLogout() {
  clearMessage();
  setButtonLoading(logoutBtn, true, "Log Out", "Logging out...");
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    loginPasswordInput.value  = "";
    signupPasswordInput.value = "";
    showMessage("You have been logged out.", "success");
  } catch (err) {
    showMessage(err.message || "Failed to log out.", "error");
  } finally {
    setButtonLoading(logoutBtn, false, "Log Out", "Logging out...");
  }
}

async function handleGoogleLogin() {
  clearMessage();
  if (googleLoginBtn) googleLoginBtn.disabled = true;
  if (googleBtnText)  googleBtnText.textContent = "Connecting to Google...";
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    });
    if (error) throw error;
  } catch (err) {
    showMessage(err.message || "Failed to sign in with Google.", "error");
    if (googleLoginBtn) googleLoginBtn.disabled  = false;
    if (googleBtnText)  googleBtnText.textContent = "Continue with Google";
  }
}


// ============================================================================
// 12. Event Listeners & Auth State
// ============================================================================

signupForm.addEventListener("submit", handleSignUp);
loginForm.addEventListener("submit",  handleLogin);
logoutBtn.addEventListener("click",   handleLogout);
addNoteForm.addEventListener("submit", handleAddNote);

tabLogin.addEventListener("click",  () => setActiveTab("login"));
tabSignup.addEventListener("click", () => setActiveTab("signup"));
switchToSignupLink.addEventListener("click", (e) => { e.preventDefault(); setActiveTab("signup"); });
switchToLoginLink.addEventListener("click",  (e) => { e.preventDefault(); setActiveTab("login"); });

if (googleLoginBtn) googleLoginBtn.addEventListener("click", handleGoogleLogin);

function checkUrlAuthFeedback() {
  const hash         = window.location.hash.substring(1);
  const search       = window.location.search.substring(1);
  const hashParams   = new URLSearchParams(hash);
  const searchParams = new URLSearchParams(search);
  const errorDesc    = hashParams.get("error_description") || searchParams.get("error_description");

  if (errorDesc) {
    showMessage(decodeURIComponent(errorDesc.replace(/\+/g, " ")), "error");
    history.replaceState(null, "", window.location.pathname);
    return;
  }
  const type = hashParams.get("type") || searchParams.get("type");
  if (type === "signup" || type === "recovery") {
    showMessage("Email confirmed! You can now log in.", "success");
    history.replaceState(null, "", window.location.pathname);
  }
}

supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === "TOKEN_REFRESHED") return;
  updateAuthUI(session ? session.user : null);
});

async function initSession() {
  checkUrlAuthFeedback();
  // Eagerly open IndexedDB so it's warm before the user logs in
  await NotesDB.open().catch(console.error);
  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) console.warn("Session retrieval warning:", error.message);
    updateAuthUI(session ? session.user : null);
  } catch (err) {
    console.error("Session init error:", err);
  }
}

initSession();
