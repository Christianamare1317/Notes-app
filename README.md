# Notes Web App - Stage 2 (Authentication & Notes CRUD)

A clean, lively, and chill notes web application built with plain **HTML, CSS, and vanilla JavaScript** (no React, no build tools, no frameworks) powered by **Supabase**.

---

## 📁 Project Structure & File Roles

- [**`index.html`**](file:///c:/Users/hp/Desktop/Notes-app/index.html): Defines the structure for both the Authentication screen (Log In / Sign Up tabs) and the Notes Dashboard (user status bar, note creation form, loading/empty state indicators, and notes list container).
- [**`style.css`**](file:///c:/Users/hp/Desktop/Notes-app/style.css): Houses the lively and chill light theme design tokens (pure white cards, ambient warmth, and indigo accent `#4f46e5`), responsive layouts, and note card styling.
- [**`config.js`**](file:///c:/Users/hp/Desktop/Notes-app/config.js): Stores the Supabase project URL and anon publishable key safely for client-side execution.
- [**`app.js`**](file:///c:/Users/hp/Desktop/Notes-app/app.js): Contains all application logic, Supabase client initialization, authentication handlers, and complete CRUD notes management (fetch, add, inline edit, delete with confirmation, and safe text rendering).

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

1. **Add Note Form**:
   - Collects `title` and `content`.
   - **Blocks empty titles** (Rule 5).
   - **Never sends `user_id`** (Rule 1); Supabase automatically fills `user_id` via default `auth.uid()`.
2. **Notes List**:
   - Queries `notes` table ordered **newest first** (`created_at` descending).
   - Displays each note's title, content, and formatted last edited time.
   - Displays **loading state** while fetching and an **empty state** (“No notes yet”) when there are zero notes (Rule 3).
3. **Inline Edit & Save**:
   - Each note card has an **Edit** button that switches it into an editable form.
   - Enforces non-empty title on save.
   - Sets `updated_at` to the current timestamp (`new Date().toISOString()`) when saving.
4. **Delete with Confirmation**:
   - Each note has a **Delete** button that triggers a browser confirmation dialog before calling Supabase delete.
5. **XSS Protection**:
   - Renders all user titles and content using **`textContent`** (never `innerHTML`) so pasted HTML or script tags cannot execute (Rule 4).
6. **Frontend Security**:
   - Uses exclusively the anon publishable key (Rule 2).
