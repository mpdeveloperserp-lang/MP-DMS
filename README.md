# MP DMS — Upload + Approval Workflow Engine

A working slice of the Enterprise DMS blueprint: **upload a document → it moves through a
configurable approval chain → gets digitally signed and published**, with full history,
version control on rejection, and real-time notifications. Built as a single-page
HTML/CSS/JS app on Firebase — no build step, no server to run.

Files:
- `index.html` — the app (structure + styles + core upload/auth logic)
- `app-workflow.js` — queue, approvals, document detail, resubmission, notifications
- `firestore.rules`, `storage.rules` — security rules to paste into Firebase
- `firestore.indexes.json` — composite indexes the app's queries need

## The workflow it implements

```
Upload → Stage 1: Planning Review + QA Review (parallel, both required)
       → Stage 2: Project Manager Approval
       → Stage 3: Management Approval + typed digital signature → Published
```

A **reject at any stage** sends the document to `Rejected`. The original uploader (or
an Admin) can then submit a revised version, which starts a fresh v2 at Stage 1 —
the old version stays in the history, marked superseded.

## 1. Set up Firebase (10 minutes)

1. Go to the [Firebase console](https://console.firebase.google.com) → **Add project**.
2. In your new project: **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** (start in production mode; the rules file below locks it down).
4. **Build → Storage → Get started** (same bucket, default settings are fine).
5. **Project settings → General → Your apps → Add app → Web (`</>`)**. Copy the `firebaseConfig` object it gives you.
6. Open `index.html`, find the `firebaseConfig` block near the top of the `<script>` section, and paste your real values in place of the `YOUR_...` placeholders.

## 2. Deploy the security rules and indexes

Easiest path — paste directly in the console:
- **Firestore → Rules** tab → paste the contents of `firestore.rules` → Publish.
- **Storage → Rules** tab → paste the contents of `storage.rules` → Publish.

Or, if you have the Firebase CLI (`npm install -g firebase-tools`, then `firebase login`, `firebase init` in this folder):
```
firebase deploy --only firestore:rules,firestore:indexes,storage:rules
```

**About the indexes:** the app's "My Approval Queue" and notification bell run
queries Firestore can't auto-index (a collection-group filter, and two
equality+order-by combinations). If you skip deploying `firestore.indexes.json`,
the first time each query runs you'll see a `failed-precondition` error in the
browser console with a **direct link to auto-create that exact index** — click it,
wait about a minute, and refresh. Either path works; the CLI just does all three up front.

## 3. Host it

Same pattern as your other apps — drop these files in a GitHub repo and enable
**GitHub Pages** on it, or just open `index.html` locally for testing (Firebase
Auth/Firestore/Storage all work fine from a local file as long as the domain — or
`localhost` — is in your Firebase project's **Authentication → Settings →
Authorized domains** list).

## 4. Try it end-to-end

Register a few accounts with different roles so you can see the whole chain move:
one **Project Engineer** (uploader), one **Planning Engineer**, one **QA Manager**,
one **Project Manager**, one **Management**. Upload a document as the engineer,
then sign in as each reviewer in turn to approve it along.

## Data model (Firestore)

```
users/{uid}                        name, email, role, department
documents/{docId}                  title, drawingNumber, project, department, category,
                                    currentVersionNo, currentVersionId, status, createdBy, ...
  └ versions/{versionId}           versionNo, revision, fileURL, uploadedBy, status,
                                    currentStage, steps[], signedBy, signedAt, supersededBy
      └ history/{eventId}          action, actor, timestamp, remarks (append-only)
notifications/{id}                 forRole | toUid, message, docId, readBy[]
```

`steps[]` on a version is the four-step workflow above, each with
`{ key, label, role, stage, decision, decidedBy, decidedAt, remarks }`.

## Security model & what to harden before a wider rollout

This build's Firestore rules require **sign-in**, but they don't independently
verify server-side that the person calling "approve" actually holds the assigned
reviewer role — that check currently lives in the browser code. For a trusted
internal pilot with a handful of people, that's a reasonable trade-off to get a
working lifecycle engine in front of people fast. Before this holds documents you
can't afford to have forged (legal agreements, statutory approvals), the
recommended next step is to move the approve/reject/publish writes into a small
**Cloud Function** that checks the caller's role via a **custom claim** (set once,
server-side, when an admin assigns a role) rather than trusting the client. Happy
to build that hardening pass, and the full Document Library/search module you
mentioned wanting next, whenever you're ready.

## What's intentionally not in this build

Per the scope we agreed on (lifecycle engine first), this pass does not include:
document search/filtering, the full metadata schema from the FRD, SLA auto-escalation
emails/SMS/WhatsApp (the "Overdue" tag is computed client-side, not a real scheduled
job), or CAD/DWG in-browser preview. All of those are natural next slices.
