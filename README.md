# Notes Web App - Stage 3 (Authentication, Notes CRUD & File Attachments)

A clean, lively, and chill notes web application built with plain **HTML, CSS, and vanilla JavaScript** (no React, no build tools, no frameworks) powered by **Supabase**.

---

## 📁 Project Structure & File Roles

- [**`index.html`**](file:///c:/Users/hp/Desktop/Notes-app/index.html): Defines the structure for both the Authentication screen (Log In / Sign Up tabs) and the Notes Dashboard (user status bar, note creation form, loading/empty state indicators, and notes list container).
- [**`style.css`**](file:///c:/Users/hp/Desktop/Notes-app/style.css): Houses the lively and chill light theme design tokens, responsive layouts, note card styling, image thumbnails, and PDF attachment cards.
- [**`config.js`**](file:///c:/Users/hp/Desktop/Notes-app/config.js): Stores the Supabase project URL and anon publishable key safely for client-side execution.
- [**`app.js`**](file:///c:/Users/hp/Desktop/Notes-app/app.js): Contains all application logic: Supabase client initialization, authentication handlers, CRUD notes management, file attachment upload/download with private signed URLs, and file deletion.
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

1. **File Attachments via Private Supabase Storage**:
   - Uses the private bucket `note-files`.
   - Stores file metadata in the `note_files` table (`id, note_id, user_id, file_path, file_name, mime_type, size_bytes, created_at`).
   - Generates private signed URLs with a **one-hour expiry** via `createSignedUrl()`.
2. **File Validation**:
   - Allows only **JPG, PNG, WebP, and PDF** files.
   - Restricts file sizes to **5 MB**.
   - Validates in JavaScript and displays clear user error messages.
3. **Safe Storage Path**:
   - Path format: `{user id}/{note id}/{random uuid}.{extension}`.
   - Never uses original file names in storage paths.
   - Original file names are stored safely in `note_files.file_name`.
   - **Never sends `user_id`** in `note_files` insert (handled automatically by Supabase default/trigger).
4. **Displaying Attachments**:
   - Images are rendered as thumbnails that open the full image in a new tab.
   - PDFs are rendered as document cards that open in a new tab with `target="_blank"` and `rel="noopener noreferrer"`.
   - File names are rendered strictly with **`textContent`** (never `innerHTML`) to prevent XSS.
5. **Per-Attachment Deletion**:
   - Each attachment has its own delete button that removes the file from storage and deletes its row from `note_files`.
6. **Cascade Cleanup on Note Deletion**:
   - When a note is deleted, all associated files are removed from Supabase storage first, then the note is deleted.
7. **Frontend Security**:
   - Operates exclusively with the publishable anon key.
