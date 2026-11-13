# Notes Web App - Stage 4 (Authentication, Google OAuth, Notes CRUD & File Attachments)

A clean, lively, and chill notes web application built with plain **HTML, CSS, and vanilla JavaScript** (no React, no build tools, no frameworks) powered by **Supabase**.

---

## 📁 Project Structure & File Roles

- [**`index.html`**](file:///c:/Users/hp/Desktop/Notes-app/index.html): Defines the structure for both the Authentication screen (Log In / Sign Up tabs and "Continue with Google" OAuth button) and the Notes Dashboard (user status bar, note creation form, loading/empty state indicators, and notes list container). Also links the PWA manifest and registers the service worker.
- [**`style.css`**](file:///c:/Users/hp/Desktop/Notes-app/style.css): Houses the lively and chill light theme design tokens, responsive layouts, note card styling, Google OAuth button, image thumbnails, and PDF attachment cards.
- [**`manifest.json`**](file:///c:/Users/hp/Desktop/Notes-app/manifest.json): Web App Manifest for PWA installability on desktop and mobile devices.
- [**`sw.js`**](file:///c:/Users/hp/Desktop/Notes-app/sw.js): Service Worker managing offline app shell caching and network fallback strategies.
- [**`logo.svg`**](file:///c:/Users/hp/Desktop/Notes-app/logo.svg) & [**`favicon.svg`**](file:///c:/Users/hp/Desktop/Notes-app/favicon.svg): Modern, high-craft brand logo and vector favicon featuring the folded note sheet, lively golden sunburst fold, and radiant inspiration sparks.
- [**`icon-192x192.png`**](file:///c:/Users/hp/Desktop/Notes-app/icon-192x192.png) & [**`icon-512x512.png`**](file:///c:/Users/hp/Desktop/Notes-app/icon-512x512.png): Standard PWA install icons.
- [**`favicon.ico`**](file:///c:/Users/hp/Desktop/Notes-app/favicon.ico) & [**`apple-touch-icon.png`**](file:///c:/Users/hp/Desktop/Notes-app/apple-touch-icon.png): Multi-resolution device and browser tab icons (16x16, 32x32, 48x48, 180x180, 512x512).
- [**`config.js`**](file:///c:/Users/hp/Desktop/Notes-app/config.js): Stores the Supabase project URL and anon publishable key safely for client-side execution.
- [**`app.js`**](file:///c:/Users/hp/Desktop/Notes-app/app.js): Contains all application logic: Supabase client initialization, email auth and Google OAuth handlers, CRUD notes management, file attachment upload/download with private signed URLs, and file deletion.
- [**`README.md`**](file:///c:/Users/hp/Desktop/Notes-app/README.md): Documentation and user guide.

---

## 🚀 How to Run the App

### Option 1: Direct File Open
Simply double-click [**`index.html`**](file:///c:/Users/hp/Desktop/Notes-app/index.html) to open it in Chrome, Edge, Firefox, or Safari.

### Option 2: Local HTTP Server (Recommended)
Run Python's built-in web server in PowerShell / terminal:
```bash
python -m http.server 3000
```
Then visit [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🔑 Features & Compliance with Rules

1. **Google OAuth ("Continue with Google")**:
   - Uses `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })`.
   - Accessible from both the Log In and Sign Up tabs with a clean divider.
   - Shows loading feedback while redirecting and clear error alerts if canceled or rejected.
   - Restores session automatically upon return using existing `onAuthStateChange` and `getSession()` listeners.
   - **Frontend Security**: Operates strictly with the Supabase anon publishable key. Never includes any Google client secret in the code (Google credentials belong exclusively in the Supabase Dashboard under Authentication → Providers → Google).
2. **File Attachments via Private Supabase Storage**:
   - Uses the private bucket `note-files`.
   - Stores file metadata in the `note_files` table (`id, note_id, user_id, file_path, file_name, mime_type, size_bytes, created_at`).
   - Generates private signed URLs with a **one-hour expiry** via `createSignedUrl()`.
3. **File Validation**:
   - Allows only **JPG, PNG, WebP, and PDF** files up to **5 MB**.
   - Validates in JavaScript and displays clear user error messages.
4. **Safe Storage Path**:
   - Path format: `{user id}/{note id}/{random uuid}.{extension}`.
   - Never uses original file names in storage paths.
   - Original file names are stored safely in `note_files.file_name`.
   - **Never sends `user_id`** in `note_files` insert.
5. **Displaying Attachments**:
   - Images are rendered as thumbnails that open the full image in a new tab.
   - PDFs are rendered as document cards that open in a new tab with `target="_blank"` and `rel="noopener noreferrer"`.
   - File names are rendered strictly with **`textContent`** (never `innerHTML`) to prevent XSS.
6. **Per-Attachment Deletion & Note Cleanup**:
   - Each attachment has a delete button that removes the file from storage and deletes its database row.
   - When a note is deleted, all associated files are removed from Supabase storage first, then the note is deleted.
7. **Progressive Web App (PWA) Offline & Mobile Installation**:
   - Full Web App Manifest (`manifest.json`) configuring standalone display, orientation, theme colors, and multi-size icons.
   - Dedicated Service Worker (`sw.js`) precaching core app shell files for instantaneous loading and offline access.
   - Smart caching strategy: caches static assets while safely bypassing Supabase API and Auth endpoints so network operations remain completely unaffected.
   - Installable on mobile devices (iOS via "Add to Home Screen", Android via Chrome install prompt) and desktop (Chrome / Edge app install).
