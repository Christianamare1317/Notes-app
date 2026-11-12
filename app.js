/**
 * app.js - Notes App Logic (Stage 2: Authentication & Notes Management)
 * 
 * Features:
 * - Initializes Supabase JS client using credentials from config.js
 * - Handles User Sign Up (supabase.auth.signUp)
 * - Handles User Log In (supabase.auth.signInWithPassword)
 * - Handles User Log Out (supabase.auth.signOut)
 * - Handles Resending Confirmation Emails (supabase.auth.resend)
 * - Persists and listens to Auth state changes without race conditions
 * - CRUD Notes Management:
 *     1. Load notes, newest first (created_at DESC)
 *     2. Add note with title and content (blocks empty titles, never sends user_id)
 *     3. Edit note inline with active edit protection and save with updated_at timestamp
 *     4. Delete note with user confirmation
 * - Safe text rendering: Uses textContent (never innerHTML) to prevent XSS attacks
 * - Loading, Empty, Success, and Error states
 */

// ============================================================================
// 1. Supabase Client Initialization
// ============================================================================

// Verify that the Supabase CDN script loaded properly
if (typeof supabase === "undefined") {
  console.error("Supabase library not loaded. Check the CDN script tag in index.html.");
}

// Normalize the Supabase URL:
// The Supabase JS client expects the project root URL (e.g., "https://xyz.supabase.co").
// If SUPABASE_URL in config.js contains the REST endpoint path ("/rest/v1/"),
// we remove it so Auth and Table requests resolve to the root project properly.
const normalizedSupabaseUrl = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");

// Create the Supabase client instance using the root URL and the public anon key.
// RULE 2: Use only the publishable key in the frontend.
const supabaseClient = supabase.createClient(normalizedSupabaseUrl, SUPABASE_ANON_KEY);


// ============================================================================
// 2. DOM Elements & State Variables
// ============================================================================

// App Container Wrapper
const appContainer = document.getElementById("app-container");

// Main Views
const authView = document.getElementById("auth-view");
const dashboardView = document.getElementById("dashboard-view");

// Feedback Banner
const messageBanner = document.getElementById("message-banner");

// Auth Tabs & Switch Links
const tabLogin = document.getElementById("tab-login");
const tabSignup = document.getElementById("tab-signup");
const switchToSignupLink = document.getElementById("switch-to-signup");
const switchToLoginLink = document.getElementById("switch-to-login");

// Auth Forms & Inputs
const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const loginEmailInput = document.getElementById("login-email");
const loginPasswordInput = document.getElementById("login-password");
const signupEmailInput = document.getElementById("signup-email");
const signupPasswordInput = document.getElementById("signup-password");
const loginSubmitBtn = document.getElementById("login-submit-btn");
const signupSubmitBtn = document.getElementById("signup-submit-btn");

// Social OAuth Elements
const googleLoginBtn = document.getElementById("google-login-btn");
const googleBtnText = document.getElementById("google-btn-text");

// Dashboard / Profile Elements
const loggedInUserEmail = document.getElementById("logged-in-user-email");
const logoutBtn = document.getElementById("logout-btn");

// Notes Elements
const addNoteForm = document.getElementById("add-note-form");
const noteTitleInput = document.getElementById("note-title-input");
const noteContentInput = document.getElementById("note-content-input");
const addNoteSubmitBtn = document.getElementById("add-note-submit-btn");

const notesLoading = document.getElementById("notes-loading");
const notesEmpty = document.getElementById("notes-empty");
const notesList = document.getElementById("notes-list");
const notesCountBadge = document.getElementById("notes-count-badge");

// Application State Tracking
let userNotes = [];                 // Local cache of notes
let currentUserId = null;           // Currently authenticated user ID
let isNotesLoaded = false;          // Prevents duplicate initial fetches
let isLoadingNotes = false;         // Prevents parallel fetch race conditions
let currentlyEditingNoteId = null;  // Protects currently edited note from being reset

// Auto-dismiss timers for feedback notifications
let messageTimeoutId = null;
let messageFadeTimeoutId = null;


// ============================================================================
// 3. UI Helper Functions
// ============================================================================

/**
 * Display a user feedback banner with an error or success message.
 * Notifications auto-dismiss smoothly after a few seconds (3s for success, 6s for errors).
 * @param {string} content - Message or HTML markup to display
 * @param {"error" | "success"} type - Message type
 * @param {boolean} isHtml - Whether content contains HTML markup
 * @param {number|null} duration - Optional custom auto-dismiss duration in ms
 */
function showMessage(content, type = "error", isHtml = false, duration = null) {
  // Clear any active auto-dismiss timers
  if (messageTimeoutId) {
    clearTimeout(messageTimeoutId);
    messageTimeoutId = null;
  }
  if (messageFadeTimeoutId) {
    clearTimeout(messageFadeTimeoutId);
    messageFadeTimeoutId = null;
  }

  // Remove fade-out styling
  messageBanner.classList.remove("fade-out");

  if (isHtml) {
    messageBanner.innerHTML = content;
  } else {
    messageBanner.textContent = content;
  }
  messageBanner.className = `message-banner ${type}`;

  // Default duration: 3200ms for positive confirmations, 6000ms for errors
  const autoDismissDelay = duration !== null ? duration : (type === "success" ? 3200 : 6000);

  if (autoDismissDelay > 0) {
    // Initiate smooth 300ms fade-out right before hiding
    messageFadeTimeoutId = setTimeout(() => {
      messageBanner.classList.add("fade-out");
    }, autoDismissDelay - 300);

    // Completely clear banner
    messageTimeoutId = setTimeout(() => {
      clearMessage();
    }, autoDismissDelay);
  }
}

/**
 * Clear the current feedback banner immediately.
 */
function clearMessage() {
  if (messageTimeoutId) {
    clearTimeout(messageTimeoutId);
    messageTimeoutId = null;
  }
  if (messageFadeTimeoutId) {
    clearTimeout(messageFadeTimeoutId);
    messageFadeTimeoutId = null;
  }

  messageBanner.classList.remove("fade-out");
  messageBanner.innerHTML = "";
  messageBanner.className = "message-banner hidden";
}

/**
 * Toggle button loading state to prevent double clicks and provide feedback.
 * @param {HTMLButtonElement} button - The button to toggle
 * @param {boolean} isLoading - Loading status
 * @param {string} defaultText - Button text when idle
 * @param {string} loadingText - Button text when loading
 */
function setButtonLoading(button, isLoading, defaultText, loadingText) {
  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : defaultText;
}

/**
 * Switch the visible auth form between "Log In" and "Sign Up".
 * @param {"login" | "signup"} formName 
 */
function setActiveTab(formName) {
  clearMessage();

  if (formName === "login") {
    loginForm.classList.remove("hidden");
    signupForm.classList.add("hidden");

    tabLogin.classList.add("active");
    tabLogin.setAttribute("aria-selected", "true");
    tabSignup.classList.remove("active");
    tabSignup.setAttribute("aria-selected", "false");
    
    loginEmailInput.focus();
  } else {
    signupForm.classList.remove("hidden");
    loginForm.classList.add("hidden");

    tabSignup.classList.add("active");
    tabSignup.setAttribute("aria-selected", "true");
    tabLogin.classList.remove("active");
    tabLogin.setAttribute("aria-selected", "false");
    
    signupEmailInput.focus();
  }
}

/**
 * Format timestamp into a clean, human-readable date and time string.
 * e.g., "Nov 8, 2026, 8:45 PM"
 * @param {string} timestamp - ISO timestamp string
 * @returns {string}
 */
function formatNoteDate(timestamp) {
  if (!timestamp) return "Just now";
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return "Recently";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return "Recently";
  }
}

/**
 * Update UI view depending on authentication state.
 * Deduplicates calls to prevent parallel race conditions.
 * @param {object|null} user - The authenticated user object or null
 */
function updateAuthUI(user) {
  const newUserId = user ? user.id : null;

  if (user) {
    // User is logged in: show notes dashboard, hide auth card
    authView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    appContainer.classList.add("expanded");
    loggedInUserEmail.textContent = user.email || "Unknown user";

    // Only load notes if user changed or notes have not been fetched yet
    if (newUserId !== currentUserId || !isNotesLoaded) {
      currentUserId = newUserId;
      isNotesLoaded = true;
      loadNotes();
    }
  } else {
    // User is logged out: reset state and show auth card
    currentUserId = null;
    isNotesLoaded = false;
    currentlyEditingNoteId = null;

    dashboardView.classList.add("hidden");
    authView.classList.remove("hidden");
    appContainer.classList.remove("expanded");
    loggedInUserEmail.textContent = "";

    // Clear notes list and local state
    userNotes = [];
    notesList.innerHTML = "";
    notesCountBadge.textContent = "0";
  }
}


// ============================================================================
// 4. Supabase Authentication Handlers
// ============================================================================

/**
 * Resend email confirmation link if user needs a new token
 * @param {string} email - User email address
 */
async function handleResendConfirmation(email) {
  if (!email) {
    showMessage("Please enter your email above first.", "error");
    return;
  }

  showMessage("Sending a new confirmation email...", "success");

  try {
    const resendOptions = {};
    if (window.location.protocol.startsWith("http")) {
      resendOptions.emailRedirectTo = window.location.origin + window.location.pathname;
    }

    const { error } = await supabaseClient.auth.resend({
      type: "signup",
      email: email,
      options: resendOptions
    });

    if (error) {
      throw error;
    }

    showMessage("A new confirmation email has been sent! Please check your inbox (and spam folder).", "success");
  } catch (err) {
    console.error("Resend error:", err);
    showMessage(err.message || "Could not resend confirmation email. Please wait a moment and try again.", "error");
  }
}

/**
 * Handle new user registration with Supabase Auth
 */
async function handleSignUp(event) {
  event.preventDefault();
  clearMessage();

  const email = signupEmailInput.value.trim();
  const password = signupPasswordInput.value;

  // Basic client-side validation
  if (!email || !password) {
    showMessage("Please provide both an email and a password.", "error");
    return;
  }

  if (password.length < 6) {
    showMessage("Password must be at least 6 characters long.", "error");
    return;
  }

  setButtonLoading(signupSubmitBtn, true, "Create Account", "Creating Account...");

  try {
    const signUpOptions = {};
    if (window.location.protocol.startsWith("http")) {
      signUpOptions.emailRedirectTo = window.location.origin + window.location.pathname;
    }

    const { data, error } = await supabaseClient.auth.signUp({
      email: email,
      password: password,
      options: signUpOptions
    });

    if (error) {
      throw error;
    }

    if (data.user && !data.session) {
      showMessage(
        "Registration successful! Please check your email inbox to confirm your account before logging in.",
        "success"
      );
      setActiveTab("login");
      loginEmailInput.value = email;
      loginPasswordInput.value = "";
    } else if (data.session) {
      showMessage("Account created and logged in successfully!", "success");
    }
  } catch (error) {
    console.error("Sign up error:", error);
    showMessage(error.message || "Failed to sign up. Please try again.", "error");
  } finally {
    setButtonLoading(signupSubmitBtn, false, "Create Account", "Creating Account...");
  }
}

/**
 * Handle user login with Supabase Auth
 */
async function handleLogin(event) {
  event.preventDefault();
  clearMessage();

  const email = loginEmailInput.value.trim();
  const password = loginPasswordInput.value;

  if (!email || !password) {
    showMessage("Please enter both email and password.", "error");
    return;
  }

  setButtonLoading(loginSubmitBtn, true, "Log In", "Logging in...");

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) {
      throw error;
    }

    showMessage("Logged in successfully!", "success");
  } catch (error) {
    console.error("Login error:", error);
    const msg = error.message || "";

    if (msg.toLowerCase().includes("email not confirmed")) {
      showMessage(
        `Email not confirmed yet. Check your inbox or <a href="#" id="resend-confirmation-link" class="link">click here to resend the confirmation email</a>.`,
        "error",
        true
      );
      const resendLink = document.getElementById("resend-confirmation-link");
      if (resendLink) {
        resendLink.addEventListener("click", (e) => {
          e.preventDefault();
          handleResendConfirmation(email);
        });
      }
    } else {
      showMessage(msg || "Failed to log in. Please check your credentials.", "error");
    }
  } finally {
    setButtonLoading(loginSubmitBtn, false, "Log In", "Logging in...");
  }
}

/**
 * Handle user logout with Supabase Auth
 */
async function handleLogout() {
  clearMessage();
  setButtonLoading(logoutBtn, true, "Log Out", "Logging out...");

  try {
    const { error } = await supabaseClient.auth.signOut();

    if (error) {
      throw error;
    }

    loginPasswordInput.value = "";
    signupPasswordInput.value = "";

    showMessage("You have been logged out.", "success");
  } catch (error) {
    console.error("Logout error:", error);
    showMessage(error.message || "Failed to log out.", "error");
  } finally {
    setButtonLoading(logoutBtn, false, "Log Out", "Logging out...");
  }
}

/**
 * Handle OAuth sign-in with Google.
 * Uses supabase.auth.signInWithOAuth.
 * Never adds any Google client secret to the frontend code.
 */
async function handleGoogleLogin() {
  clearMessage();

  // Show loading state
  if (googleLoginBtn) {
    googleLoginBtn.disabled = true;
  }
  if (googleBtnText) {
    googleBtnText.textContent = "Connecting to Google...";
  }

  try {
    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin
      }
    });

    if (error) {
      throw error;
    }

    // Supabase will redirect the browser to Google for authentication.
    // Upon return, existing session handling will automatically restore the logged-in state.
  } catch (err) {
    console.error("Google OAuth error:", err);
    showMessage(err.message || "Failed to sign in with Google. Please try again.", "error");

    // Reset button loading state on error
    if (googleLoginBtn) {
      googleLoginBtn.disabled = false;
    }
    if (googleBtnText) {
      googleBtnText.textContent = "Continue with Google";
    }
  }
}


// ============================================================================
// 5. Notes & File Attachments Feature (CRUD & Storage Operations)
// ============================================================================

// Storage & Attachment Constants
const STORAGE_BUCKET = "note-files";
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "pdf"];
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
];

/**
 * Extract lowercase file extension from a filename.
 * @param {string} filename 
 * @returns {string}
 */
function getFileExtension(filename) {
  if (!filename || typeof filename !== "string") return "";
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

/**
 * Format bytes into human-readable file size string (B, KB, MB).
 * @param {number} bytes 
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Generate a random UUID string (RFC4122 v4 compliant).
 * @returns {string}
 */
function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Check if a file is an image based on its mime type or extension.
 * @param {string} mimeType 
 * @param {string} filename 
 * @returns {boolean}
 */
function isImageFile(mimeType, filename) {
  if (mimeType && mimeType.startsWith("image/")) return true;
  const ext = getFileExtension(filename);
  return ["jpg", "jpeg", "png", "webp"].includes(ext);
}

/**
 * Validate attachment file type and size.
 * Allows only JPG, PNG, WebP, and PDF up to 5 MB.
 * @param {File} file 
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAttachmentFile(file) {
  if (!file) {
    return { valid: false, error: "No file selected." };
  }

  // Check file size (up to 5 MB)
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File "${file.name}" exceeds the 5 MB limit (${formatFileSize(file.size)}). Please choose a smaller file.`
    };
  }

  // Check file extension and MIME type
  const extension = getFileExtension(file.name);
  const isAllowedExt = ALLOWED_EXTENSIONS.includes(extension);
  const isAllowedMime = ALLOWED_MIME_TYPES.includes(file.type) || isAllowedExt;

  if (!isAllowedExt || !isAllowedMime) {
    return {
      valid: false,
      error: `Invalid file type for "${file.name}". Only JPG, PNG, WebP, and PDF files are allowed.`
    };
  }

  return { valid: true };
}

/**
 * Obtain a signed URL for a private storage file with a one-hour expiry.
 * @param {string} filePath 
 * @returns {Promise<string|null>}
 */
async function getSignedAttachmentUrl(filePath) {
  try {
    // createSignedUrl with 3600 seconds (1 hour) expiry
    const { data, error } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(filePath, 3600);

    if (error || !data) {
      console.error("Error creating signed URL:", error);
      return null;
    }
    return data.signedUrl;
  } catch (err) {
    console.error("Signed URL exception:", err);
    return null;
  }
}

/**
 * Load notes and their attachments for the authenticated user, newest first.
 * RULE 3: Shows loading state and empty state ("No notes yet").
 * Prevents race conditions and protects in-progress edits from being wiped.
 */
async function loadNotes() {
  if (isLoadingNotes) return;
  isLoadingNotes = true;

  if (userNotes.length === 0) {
    notesLoading.classList.remove("hidden");
    notesEmpty.classList.add("hidden");
    notesList.innerHTML = "";
  }

  try {
    // 1. Fetch user's notes ordered newest first (created_at DESC)
    const { data: notesData, error: notesError } = await supabaseClient
      .from("notes")
      .select("*")
      .order("created_at", { ascending: false });

    if (notesError) {
      throw notesError;
    }

    // 2. Fetch attachments from note_files table
    const { data: filesData, error: filesError } = await supabaseClient
      .from("note_files")
      .select("*")
      .order("created_at", { ascending: true });

    if (filesError) {
      console.warn("Could not load note attachments:", filesError.message);
    }

    const allFiles = filesData || [];

    // 3. Associate attachments with each note
    userNotes = (notesData || []).map((note) => {
      note.files = allFiles.filter((f) => f.note_id === note.id);
      return note;
    });

    if (!currentlyEditingNoteId) {
      await renderNotesList();
    } else {
      notesCountBadge.textContent = userNotes.length;
    }
  } catch (err) {
    console.error("Error fetching notes:", err);
    showMessage(err.message || "Failed to load notes.", "error");
  } finally {
    isLoadingNotes = false;
    notesLoading.classList.add("hidden");
  }
}

/**
 * Re-render the notes list from userNotes array into the DOM.
 * RULE 3: Shows empty state ("No notes yet") if userNotes is empty.
 * RULE 4: Uses textContent to safely render all text without running HTML.
 */
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

/**
 * Create a note card DOM element in view mode.
 * RULE 4: Displays title, content, and date using textContent, never innerHTML.
 * @param {object} note - Note object with attachments { id, title, content, created_at, updated_at, files }
 * @returns {Promise<HTMLElement>}
 */
async function createNoteElement(note) {
  const card = document.createElement("article");
  card.className = "card note-card";
  card.dataset.id = note.id;

  await renderNoteView(card, note);
  return card;
}

/**
 * Render the default view state of a note card including attachments.
 * @param {HTMLElement} card - Note card container
 * @param {object} note - Note data
 */
async function renderNoteView(card, note) {
  card.innerHTML = ""; // Clear existing contents

  // Header: Title & Last Edited Time
  const header = document.createElement("div");
  header.className = "note-header";

  const titleEl = document.createElement("h3");
  titleEl.className = "note-title";
  // RULE 4: textContent used so pasted HTML cannot run as code
  titleEl.textContent = note.title;

  const dateEl = document.createElement("time");
  dateEl.className = "note-date";
  const lastEdited = note.updated_at || note.created_at;
  dateEl.textContent = `Last edited: ${formatNoteDate(lastEdited)}`;

  header.appendChild(titleEl);
  header.appendChild(dateEl);
  card.appendChild(header);

  // Content (only if present)
  if (note.content && note.content.trim()) {
    const contentEl = document.createElement("p");
    contentEl.className = "note-content";
    // RULE 4: textContent used so pasted HTML cannot run as code
    contentEl.textContent = note.content;
    card.appendChild(contentEl);
  }

  // Attachments Section
  const attachmentsContainer = document.createElement("div");
  attachmentsContainer.className = "note-attachments";
  card.appendChild(attachmentsContainer);
  await renderNoteAttachments(attachmentsContainer, note);

  // Action Buttons Bar
  const actions = document.createElement("div");
  actions.className = "note-actions";

  // Left group: "Attach file" button and hidden file input
  const actionsLeft = document.createElement("div");
  actionsLeft.className = "note-actions-left";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf";
  fileInput.style.display = "none";

  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
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

  // Right group: Edit and Delete buttons
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn-secondary btn-sm";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => renderNoteEditForm(card, note));

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn-danger btn-sm";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => handleDeleteNote(note.id, deleteBtn));

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  card.appendChild(actions);
}

/**
 * Render the attachments list (images as thumbnails, PDFs as links).
 * Uses createSignedUrl with a one-hour expiry.
 * Shows file names with textContent.
 * @param {HTMLElement} container - Note attachments container
 * @param {object} note - Note object
 */
async function renderNoteAttachments(container, note) {
  container.innerHTML = "";
  const files = note.files || [];

  if (files.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");

  // Section Header
  const header = document.createElement("div");
  header.className = "attachments-header";
  header.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
    </svg>
    <span>Attachments (${files.length})</span>
  `;
  container.appendChild(header);

  // Grid for thumbnails and PDF cards
  const grid = document.createElement("div");
  grid.className = "attachments-grid";
  container.appendChild(grid);

  for (const file of files) {
    const itemEl = await createAttachmentItem(note, file, container);
    if (itemEl) {
      grid.appendChild(itemEl);
    }
  }
}

/**
 * Create an individual attachment element (Image thumbnail or PDF link).
 * RULE: Shows file names with textContent, not innerHTML.
 * RULE: Opens in a new tab with rel="noopener noreferrer".
 * @param {object} note - Parent note
 * @param {object} file - Attachment file row
 * @param {HTMLElement} container - Attachments container for re-render
 * @returns {Promise<HTMLElement>}
 */
async function createAttachmentItem(note, file, container) {
  // Obtain signed URL with one-hour expiry (3600 seconds)
  const signedUrl = await getSignedAttachmentUrl(file.file_path);

  if (isImageFile(file.mime_type, file.file_name)) {
    // -------------------------------------------------------------
    // Image Attachment: Render as Thumbnail
    // -------------------------------------------------------------
    const imgCard = document.createElement("div");
    imgCard.className = "attachment-img-card";

    // Delete Button Overlay
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "attachment-delete-overlay";
    delBtn.title = "Delete attachment";
    delBtn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await handleDeleteAttachment(note, file, imgCard, container);
    });

    // Image Link (opens full image in new tab with rel="noopener noreferrer")
    const imgLink = document.createElement("a");
    imgLink.className = "attachment-img-link";
    imgLink.target = "_blank";
    imgLink.rel = "noopener noreferrer";
    if (signedUrl) {
      imgLink.href = signedUrl;
    }

    const img = document.createElement("img");
    img.className = "attachment-img-thumb";
    if (signedUrl) {
      img.src = signedUrl;
    }
    img.alt = file.file_name;
    img.loading = "lazy";
    imgLink.appendChild(img);

    // Caption: Show file name safely with textContent
    const nameSpan = document.createElement("span");
    nameSpan.className = "attachment-img-name";
    nameSpan.textContent = file.file_name; // RULE: textContent
    nameSpan.title = file.file_name;

    imgCard.appendChild(delBtn);
    imgCard.appendChild(imgLink);
    imgCard.appendChild(nameSpan);

    return imgCard;
  } else {
    // -------------------------------------------------------------
    // PDF Attachment: Render as Link with File Name and Delete Button
    // -------------------------------------------------------------
    const pdfCard = document.createElement("div");
    pdfCard.className = "attachment-pdf-card";

    // Link: Opens PDF in new tab with rel="noopener noreferrer"
    const pdfLink = document.createElement("a");
    pdfLink.className = "attachment-pdf-link";
    pdfLink.target = "_blank";
    pdfLink.rel = "noopener noreferrer";
    if (signedUrl) {
      pdfLink.href = signedUrl;
    }

    // PDF Icon
    pdfLink.innerHTML = `
      <svg width="16" height="16" class="attachment-pdf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
      </svg>
    `;

    // File Name Label (RULE: textContent)
    const nameSpan = document.createElement("span");
    nameSpan.className = "attachment-pdf-name";
    nameSpan.textContent = file.file_name; // RULE: textContent
    nameSpan.title = file.file_name;
    pdfLink.appendChild(nameSpan);

    // File Size Label
    if (file.size_bytes) {
      const sizeSpan = document.createElement("span");
      sizeSpan.className = "attachment-pdf-size";
      sizeSpan.textContent = `(${formatFileSize(file.size_bytes)})`;
      pdfLink.appendChild(sizeSpan);
    }

    // Delete Button per attachment
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "attachment-pdf-delete";
    delBtn.title = "Delete attachment";
    delBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    delBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleDeleteAttachment(note, file, pdfCard, container);
    });

    pdfCard.appendChild(pdfLink);
    pdfCard.appendChild(delBtn);

    return pdfCard;
  }
}

/**
 * Handle uploading and attaching a file to a note.
 * Checks file type and size (<= 5 MB).
 * Uploads to {user id}/{note id}/{random uuid}.{extension}. Never uses original filename in path.
 * Inserts row into note_files without sending user_id.
 * @param {object} note - Note object
 * @param {HTMLInputElement} fileInput - Hidden file input element
 * @param {HTMLButtonElement} attachBtn - Attach file button
 * @param {HTMLElement} attachmentsContainer - Container to re-render
 */
async function handleAttachFile(note, fileInput, attachBtn, attachmentsContainer) {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  clearMessage();

  // Validate type and size in JavaScript
  const validation = validateAttachmentFile(file);
  if (!validation.valid) {
    showMessage(validation.error, "error");
    fileInput.value = "";
    return;
  }

  // Ensure current user is active
  if (!currentUserId) {
    showMessage("Please log in to attach files.", "error");
    fileInput.value = "";
    return;
  }

  setButtonLoading(attachBtn, true, "Attach file", "Uploading...");

  try {
    const extension = getFileExtension(file.name);
    const randomUuid = generateUUID();

    // RULE: Path structure: {user id}/{note id}/{random uuid}.{extension}
    // Never use the original filename in the storage path.
    const storagePath = `${currentUserId}/${note.id}/${randomUuid}.${extension}`;

    // 1. Upload file to private Supabase Storage bucket 'note-files'
    const { error: uploadError } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false
      });

    if (uploadError) {
      throw uploadError;
    }

    // 2. Insert row into note_files table
    // RULE: Do not send user_id in the insert.
    const { data: insertedRow, error: insertError } = await supabaseClient
      .from("note_files")
      .insert([
        {
          note_id: note.id,
          file_path: storagePath,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          size_bytes: file.size
        }
      ])
      .select()
      .single();

    if (insertError) {
      // Clean up uploaded file if database insert fails
      await supabaseClient.storage.from(STORAGE_BUCKET).remove([storagePath]);
      throw insertError;
    }

    // Add new attachment to note object
    if (!note.files) {
      note.files = [];
    }
    note.files.push(insertedRow);

    // Update in userNotes cache
    const cachedNote = userNotes.find((n) => n.id === note.id);
    if (cachedNote) {
      cachedNote.files = note.files;
    }

    // Re-render attachments section for this note
    await renderNoteAttachments(attachmentsContainer, note);

    showMessage(`"${file.name}" attached successfully!`, "success");
  } catch (err) {
    console.error("Error attaching file:", err);
    showMessage(err.message || "Failed to attach file.", "error");
  } finally {
    fileInput.value = ""; // Reset input so same file can be selected again
    setButtonLoading(attachBtn, false, "Attach file", "Uploading...");
  }
}

/**
 * Handle deleting a single attachment.
 * Removes file from storage and deletes its row from note_files.
 * @param {object} note - Parent note
 * @param {object} file - Attachment row
 * @param {HTMLElement} itemElement - DOM element of attachment
 * @param {HTMLElement} container - Attachments container
 */
async function handleDeleteAttachment(note, file, itemElement, container) {
  clearMessage();

  const confirmed = window.confirm(`Delete attachment "${file.file_name}"?`);
  if (!confirmed) return;

  itemElement.style.opacity = "0.45";
  itemElement.style.pointerEvents = "none";

  try {
    // 1. Remove file from storage
    const { error: storageError } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .remove([file.file_path]);

    if (storageError) {
      console.warn("Storage deletion warning:", storageError.message);
    }

    // 2. Delete row from note_files table
    const { error: dbError } = await supabaseClient
      .from("note_files")
      .delete()
      .eq("id", file.id);

    if (dbError) {
      throw dbError;
    }

    // Remove from note's local attachments array
    note.files = (note.files || []).filter((f) => f.id !== file.id);

    const cachedNote = userNotes.find((n) => n.id === note.id);
    if (cachedNote) {
      cachedNote.files = note.files;
    }

    // Re-render attachments
    await renderNoteAttachments(container, note);

    showMessage("Attachment deleted successfully!", "success");
  } catch (err) {
    console.error("Error deleting attachment:", err);
    showMessage(err.message || "Failed to delete attachment.", "error");
    itemElement.style.opacity = "1";
    itemElement.style.pointerEvents = "auto";
  }
}

/**
 * Render an inline edit form inside the note card.
 * Tracks currentlyEditingNoteId so in-progress changes are never lost or overwritten.
 * @param {HTMLElement} card - Note card container
 * @param {object} note - Note data
 */
function renderNoteEditForm(card, note) {
  currentlyEditingNoteId = note.id;
  card.innerHTML = ""; // Switch to edit form

  const form = document.createElement("form");
  form.className = "edit-note-form";

  // Title Input Field
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.value = note.title;
  titleInput.required = true;
  titleInput.placeholder = "Note title...";

  // Prevent accidental submit when pressing Enter in title input:
  // Smoothly move focus to content textarea instead of prematurely closing the form
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      contentTextarea.focus();
    }
  });

  // Content Textarea Field
  const contentTextarea = document.createElement("textarea");
  contentTextarea.rows = 3;
  contentTextarea.value = note.content || "";
  contentTextarea.placeholder = "Write your note here...";

  // Action Buttons (Cancel and Save)
  const actions = document.createElement("div");
  actions.className = "edit-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-secondary btn-sm";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    currentlyEditingNoteId = null;
    clearMessage();
    renderNoteView(card, note);
  });

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "Save";

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  form.appendChild(titleInput);
  form.appendChild(contentTextarea);
  form.appendChild(actions);

  // Form Submission
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await handleSaveNoteEdit(card, note, titleInput.value, contentTextarea.value, saveBtn);
  });

  card.appendChild(form);
  titleInput.focus();
}

/**
 * Save an edited note to Supabase.
 * RULE 1: Do not send user_id.
 * RULE 5: Block empty titles.
 * Sets updated_at to the current time when saving.
 */
async function handleSaveNoteEdit(card, note, newTitle, newContent, saveBtn) {
  clearMessage();

  const trimmedTitle = newTitle.trim();
  const trimmedContent = newContent.trim();

  // RULE 5: Block empty titles
  if (!trimmedTitle) {
    showMessage("Note title cannot be empty.", "error");
    return;
  }

  setButtonLoading(saveBtn, true, "Save", "Saving...");

  try {
    const currentTime = new Date().toISOString();

    // RULE 1: Do not send user_id from the code. The database fills it in automatically.
    // Set updated_at to current time when saving.
    const { error } = await supabaseClient
      .from("notes")
      .update({
        title: trimmedTitle,
        content: trimmedContent,
        updated_at: currentTime
      })
      .eq("id", note.id);

    if (error) {
      throw error;
    }

    // Update in-memory note object
    note.title = trimmedTitle;
    note.content = trimmedContent;
    note.updated_at = currentTime;

    // Update in userNotes list array
    const index = userNotes.findIndex((n) => n.id === note.id);
    if (index !== -1) {
      userNotes[index] = { ...note };
    }

    currentlyEditingNoteId = null;

    // RULE 3: Show success message
    showMessage("Note updated successfully!", "success");

    // Re-render card back to normal view with updated details
    await renderNoteView(card, note);
  } catch (err) {
    console.error("Error saving note:", err);
    showMessage(err.message || "Failed to update note.", "error");
    setButtonLoading(saveBtn, false, "Save", "Saving...");
  }
}

/**
 * Handle new note creation.
 * RULE 1: Do not send user_id from the code. The database fills it in automatically.
 * RULE 5: Block empty titles.
 */
async function handleAddNote(event) {
  event.preventDefault();
  clearMessage();

  const title = noteTitleInput.value.trim();
  const content = noteContentInput.value.trim();

  // RULE 5: Block empty titles
  if (!title) {
    showMessage("Please enter a note title.", "error");
    noteTitleInput.focus();
    return;
  }

  setButtonLoading(addNoteSubmitBtn, true, "Add Note", "Adding Note...");

  try {
    // RULE 1: Do not send user_id. The database fills it in automatically via auth.uid().
    const { data, error } = await supabaseClient
      .from("notes")
      .insert([
        {
          title: title,
          content: content
        }
      ])
      .select();

    if (error) {
      throw error;
    }

    // Reset input fields
    noteTitleInput.value = "";
    noteContentInput.value = "";

    // RULE 3: Show success message
    showMessage("Note added successfully!", "success");

    // Prepend newly created note with empty files array
    if (data && data.length > 0) {
      const newNote = data[0];
      newNote.files = [];
      userNotes.unshift(newNote);
      await renderNotesList();
    } else {
      await loadNotes();
    }
  } catch (err) {
    console.error("Error adding note:", err);
    showMessage(err.message || "Failed to add note.", "error");
  } finally {
    setButtonLoading(addNoteSubmitBtn, false, "Add Note", "Adding Note...");
  }
}

/**
 * Handle note deletion with confirmation dialog.
 * RULE: When a note is deleted, first remove all its files from storage, then delete the note.
 * @param {string|number} noteId - ID of note to delete
 * @param {HTMLButtonElement} deleteBtn - Delete button element
 */
async function handleDeleteNote(noteId, deleteBtn) {
  clearMessage();

  const confirmed = window.confirm("Are you sure you want to delete this note and all its attachments?");
  if (!confirmed) {
    return;
  }

  if (currentlyEditingNoteId === noteId) {
    currentlyEditingNoteId = null;
  }

  setButtonLoading(deleteBtn, true, "Delete", "Deleting...");

  try {
    // 1. FIRST: Remove all files belonging to this note from storage
    const note = userNotes.find((n) => n.id === noteId);
    let noteFiles = (note && note.files) ? note.files : [];

    // Fallback: If not in local cache, query note_files table
    if (noteFiles.length === 0) {
      const { data: dbFiles } = await supabaseClient
        .from("note_files")
        .select("id, file_path")
        .eq("note_id", noteId);
      if (dbFiles) {
        noteFiles = dbFiles;
      }
    }

    if (noteFiles.length > 0) {
      const filePaths = noteFiles.map((f) => f.file_path);
      const { error: storageError } = await supabaseClient.storage
        .from(STORAGE_BUCKET)
        .remove(filePaths);

      if (storageError) {
        console.warn("Storage deletion warning:", storageError.message);
      }

      // Delete note_files rows
      await supabaseClient
        .from("note_files")
        .delete()
        .eq("note_id", noteId);
    }

    // 2. THEN: Delete the note from notes table
    const { error: noteError } = await supabaseClient
      .from("notes")
      .delete()
      .eq("id", noteId);

    if (noteError) {
      throw noteError;
    }

    // Remove from in-memory array
    userNotes = userNotes.filter((n) => n.id !== noteId);

    // Re-render notes list
    await renderNotesList();

    // RULE 3: Show success message
    showMessage("Note and all attachments deleted successfully!", "success");
  } catch (err) {
    console.error("Error deleting note:", err);
    showMessage(err.message || "Failed to delete note.", "error");
    setButtonLoading(deleteBtn, false, "Delete", "Deleting...");
  }
}


// ============================================================================
// 6. Event Listeners & Auth State Management
// ============================================================================

// Auth Form Submissions
signupForm.addEventListener("submit", handleSignUp);
loginForm.addEventListener("submit", handleLogin);

// Logout Button Click
logoutBtn.addEventListener("click", handleLogout);

// Tab and Link Switching
tabLogin.addEventListener("click", () => setActiveTab("login"));
tabSignup.addEventListener("click", () => setActiveTab("signup"));
switchToSignupLink.addEventListener("click", (e) => {
  e.preventDefault();
  setActiveTab("signup");
});
switchToLoginLink.addEventListener("click", (e) => {
  e.preventDefault();
  setActiveTab("login");
});

// Note Creation Form Submission
addNoteForm.addEventListener("submit", handleAddNote);

// Google OAuth Login Button Click
if (googleLoginBtn) {
  googleLoginBtn.addEventListener("click", handleGoogleLogin);
}

/**
 * Check if the browser URL contains auth tokens or errors from Supabase
 * (e.g. returning from email verification or Google OAuth redirect)
 */
function checkUrlAuthFeedback() {
  const hash = window.location.hash.substring(1);
  const search = window.location.search.substring(1);
  const hashParams = new URLSearchParams(hash);
  const searchParams = new URLSearchParams(search);
  
  // Check for error descriptions in both hash fragments and query string
  const errorDescription = hashParams.get("error_description") || searchParams.get("error_description");
  if (errorDescription) {
    showMessage(decodeURIComponent(errorDescription.replace(/\+/g, " ")), "error");
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  const type = hashParams.get("type") || searchParams.get("type");
  if (type === "signup" || type === "recovery") {
    showMessage("Email confirmed successfully! You can now log in.", "success");
    history.replaceState(null, "", window.location.pathname);
  }
}

/**
 * Initialize Auth State:
 * 1. Listen for auth changes (SIGNED_IN, SIGNED_OUT, etc.)
 *    Ignores silent background TOKEN_REFRESHED events to protect active in-progress edits.
 * 2. Check for an existing active session on initial page load.
 */
supabaseClient.auth.onAuthStateChange((event, session) => {
  console.log("Supabase Auth Event:", event);

  // Ignore silent background token refresh events so they don't reload or disrupt active edits
  if (event === "TOKEN_REFRESHED") {
    return;
  }

  const user = session ? session.user : null;
  updateAuthUI(user);
});

// Check current session on page load (in case user refreshed while logged in)
async function initSession() {
  checkUrlAuthFeedback();

  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error) {
      console.warn("Session retrieval warning:", error.message);
    }
    const user = session ? session.user : null;
    updateAuthUI(user);
  } catch (err) {
    console.error("Unexpected session initialization error:", err);
  }
}

initSession();
