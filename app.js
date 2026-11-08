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


// ============================================================================
// 5. Notes Feature (CRUD Operations)
// ============================================================================

/**
 * Load notes for the authenticated user, newest first.
 * RULE 3: Shows loading state and empty state ("No notes yet").
 * Prevents race conditions and protects in-progress edits from being wiped.
 */
async function loadNotes() {
  // Prevent duplicate concurrent requests
  if (isLoadingNotes) return;
  isLoadingNotes = true;

  // Show loading indicator only if list is empty
  if (userNotes.length === 0) {
    notesLoading.classList.remove("hidden");
    notesEmpty.classList.add("hidden");
    notesList.innerHTML = "";
  }

  try {
    // Supabase Row Level Security (RLS) ensures users only retrieve their own notes.
    // Query ordered newest first by created_at.
    const { data, error } = await supabaseClient
      .from("notes")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    userNotes = data || [];

    // If the user is currently editing a note, do not wipe out their active edit form!
    if (!currentlyEditingNoteId) {
      renderNotesList();
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
function renderNotesList() {
  notesList.innerHTML = "";
  notesCountBadge.textContent = userNotes.length;

  if (userNotes.length === 0) {
    // RULE 3: Show empty state containing exact text "No notes yet"
    notesEmpty.classList.remove("hidden");
  } else {
    notesEmpty.classList.add("hidden");
    userNotes.forEach((note) => {
      const noteElement = createNoteElement(note);
      notesList.appendChild(noteElement);
    });
  }
}

/**
 * Create a note card DOM element in view mode.
 * RULE 4: Displays title, content, and date using textContent, never innerHTML.
 * @param {object} note - Note object { id, title, content, created_at, updated_at }
 * @returns {HTMLElement}
 */
function createNoteElement(note) {
  const card = document.createElement("article");
  card.className = "card note-card";
  card.dataset.id = note.id;

  renderNoteView(card, note);
  return card;
}

/**
 * Render the default view state of a note card.
 * @param {HTMLElement} card - Note card container
 * @param {object} note - Note data
 */
function renderNoteView(card, note) {
  card.innerHTML = ""; // Clear existing contents (e.g. if switching back from edit form)

  // Header: Title & Last Edited Time
  const header = document.createElement("div");
  header.className = "note-header";

  const titleEl = document.createElement("h3");
  titleEl.className = "note-title";
  // RULE 4: textContent used so pasted HTML cannot run as code
  titleEl.textContent = note.title;

  const dateEl = document.createElement("time");
  dateEl.className = "note-date";
  // Shows last edited time using updated_at (fallback to created_at)
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

  // Action Buttons (Edit and Delete)
  const actions = document.createElement("div");
  actions.className = "note-actions";

  // Edit Button
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn btn-secondary btn-sm";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => renderNoteEditForm(card, note));

  // Delete Button with confirmation
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
 * Render an inline edit form inside the note card.
 * Tracks currentlyEditingNoteId so in-progress changes are never lost or overwritten.
 * @param {HTMLElement} card - Note card container
 * @param {object} note - Note data
 */
function renderNoteEditForm(card, note) {
  // Set tracking flag so background fetches cannot wipe out this edit
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

    // Clear editing lock
    currentlyEditingNoteId = null;

    // RULE 3: Show success message
    showMessage("Note updated successfully!", "success");

    // Re-render card back to normal view
    renderNoteView(card, note);
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

    // Prepend newly created note
    if (data && data.length > 0) {
      userNotes.unshift(data[0]);
      renderNotesList();
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
 * @param {string|number} noteId - ID of note to delete
 * @param {HTMLButtonElement} deleteBtn - Delete button element
 */
async function handleDeleteNote(noteId, deleteBtn) {
  clearMessage();

  // Requirement 4: Confirmation before deleting
  const confirmed = window.confirm("Are you sure you want to delete this note?");
  if (!confirmed) {
    return;
  }

  // Clear editing lock if this note was being edited
  if (currentlyEditingNoteId === noteId) {
    currentlyEditingNoteId = null;
  }

  setButtonLoading(deleteBtn, true, "Delete", "Deleting...");

  try {
    const { error } = await supabaseClient
      .from("notes")
      .delete()
      .eq("id", noteId);

    if (error) {
      throw error;
    }

    // Remove from in-memory array
    userNotes = userNotes.filter((n) => n.id !== noteId);

    // Re-render notes list
    renderNotesList();

    // RULE 3: Show success message
    showMessage("Note deleted successfully!", "success");
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

/**
 * Check if the browser URL contains auth tokens or errors from Supabase
 * (e.g. returning from email verification)
 */
function checkUrlAuthFeedback() {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash || window.location.search);
  
  const errorDescription = params.get("error_description");
  if (errorDescription) {
    showMessage(decodeURIComponent(errorDescription.replace(/\+/g, " ")), "error");
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  const type = params.get("type");
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
