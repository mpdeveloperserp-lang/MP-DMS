window.__BUILD_FILES = '2026.11.23-2'; // must match APP_BUILD in index.html
/* ============================================================
   FILE MANAGER MODULE  (app-files.js)
   IN4Suite-style document file manager, layered on the existing
   approval engine in app-workflow.js (same global scope — load it
   AFTER app-workflow.js).

   Covers:
     Files            — folder tree + Knowledge
                        Management dashboard, folder pages, search,
                        advanced search, quick links, subscriptions
     Folder actions   — Properties (reviewers/approvers), Permissions
                        (User / Role / Department, apply to subfolders),
                        New Subfolder, Delete Folder
     Root Folder      — create / rename / delete top-level folders
     Set Parameter    — allowed file types, max size, review/approval TAT
     Email Config     — emails via the Firebase "Trigger Email" extension
     Reports          — Files Details, Folder Approver Details (+ CSV)
     Alerts           — overdue reviews/approvals with reminders
     Move File Location — move files uploaded in a date range between folders
     Transfer Rights  — hand one employee's folder rights/tasks to another
     Project folders  — every project in Masters → Project Master automatically gets
                        a root folder of the same name, and each sub-item
                        (tower/block) a subfolder inside it

   Firestore collections used:
     folders/{id}        name, parentId, folderNo, description, projectMasterId
                         (set on project folders; ID is proj_<projectMasterId>),
                         permissions{users,roles,departments,applyToSubfolders},
                         reviewers[uid], approvers[uid], subscribers[uid]
     userPrefs/{uid}     quickLinks[folderId]
     dmsSettings/params  allowedExtensions, maxFileSizeMB, reviewTatDays,
                         approvalTatDays, folderNoDigits
     dmsSettings/email   enabled, fromName, fromAddress, replyTo, appUrl, event flags
     counters/folders    next (sequential folder number)
     mail/{id}           queued emails (read by the Trigger Email extension)
============================================================ */

const FOLDER_SVG = '<svg class="fm-ficon" viewBox="0 0 24 18" aria-hidden="true"><path d="M1 3a2 2 0 0 1 2-2h6l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill="#4A7CC2"/></svg>';
const FOLDER_SVG_LG = FOLDER_SVG.replace('fm-ficon', 'km-ficon');
const UNFILED = '__unfiled__';

const DEFAULT_DMS_PARAMS = {
  allowedExtensions: 'pdf,dwg,dxf,jpg,jpeg,png,doc,docx,xls,xlsx,ppt,pptx,zip,rar',
  maxFileSizeMB: 50, reviewTatDays: 2, approvalTatDays: 2, folderNoDigits: 7, signatureSheet: true
};
const DEFAULT_EMAIL_CONFIG = {
  enabled: false, fromName: 'MP DMS', fromAddress: '', replyTo: '', appUrl: '',
  onTaskAssigned: true, onRejected: true, onPublished: true, onSubscribedUpload: true
};

let dmsParams = { ...DEFAULT_DMS_PARAMS };
let emailConfig = { ...DEFAULT_EMAIL_CONFIG };
let foldersData = [];
let foldersById = new Map();
let foldersLoaded = false;
let myPrefs = { quickLinks: [] };
let prefsLoaded = false;
let fmActiveFolderId = null;
let fmExpanded = new Set();
let fmTreeFilter = '';
let fmFolderDocs = null;
let fmFolderDocsUnsub = null;
let fmKmOpen = new Set(['pendReview', 'pendApproval']); // items waiting on you are open by default
let fmOverdueOnly = false;
let fmSearchState = null;          // { crit, label, results|null }
let fmLinksPanel = null;           // 'quick' | 'subs' | null
let fmFilesUnsubs = [];
let fmFolderModal = null;          // { mode:'create'|'rename', parentId, folderId }
let fmPropsFolderId = null;
let permDraft = null, permEntity = 'user', permFolderId = null;
let fmReportRows = null, fmActiveReport = null;
let fmMoveCandidates = [];
let fmTransferFrom = null;
let fmLastUploadFolderId = null;
let fmShowAllDocs = false;        // Files > All Documents panel
let fmPendingFolderId = null;     // folder link opened before folders finished loading
let projectMastersLoaded = false;
let projectSyncInFlight = new Set(); // project master IDs whose folder is being created/renamed

/* ---------------- small helpers ---------------- */
// Record a Files location in browser history (opts.history: 'push' default | 'replace' | 'none')
function fmHistory(opts, state, hash){
  const mode = (opts && opts.history) || 'push';
  if(mode === 'none' || typeof navPush !== 'function') return;
  navPush(state, hash, mode === 'replace');
}
function showFilesView(){ if(!fmViewActive('filesView')) switchView('filesView', { skipHistory: true }); }
function fmIsAdmin(){ return !!currentUser && currentUser.role === 'admin'; }
function userName(uid){ const u = usersData.find(x => x.id === uid); return u ? u.name : (uid ? 'Unknown user' : '—'); }
function fmtFolderNo(n){ return n == null ? '—' : String(n).padStart(Number(dmsParams.folderNoDigits) || 7, '0'); }
function tsMs(ts){ return ts && ts.toMillis ? ts.toMillis() : 0; }
function fmtDay(ts){
  const ms = typeof ts === 'number' ? ts : tsMs(ts);
  return ms ? new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}
function fmViewActive(id){ const el = document.getElementById(id); return !!el && el.classList.contains('active'); }
function downloadCsv(filename, headers, rows){
  const esc = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function fetchAllDocuments(){
  return db.collection('documents').orderBy('updatedAt', 'desc').limit(5000).get()
    .then(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
}

/* ---------------- folder structure ---------------- */
function childFolders(parentId){
  return foldersData.filter(f => (f.parentId || null) === (parentId || null)).sort((a, b) => a.name.localeCompare(b.name));
}
function folderChain(id){
  const chain = []; let f = foldersById.get(id); let guard = 0;
  while(f && guard++ < 60){ chain.unshift(f); f = f.parentId ? foldersById.get(f.parentId) : null; }
  return chain;
}
function folderPath(id){
  if(!id) return '(Unfiled)';
  const ch = folderChain(id);
  return ch.length ? ch.map(f => f.name).join('/') + '/' : '(Deleted folder)';
}
function descendantIds(id){
  const out = []; const stack = [id];
  while(stack.length){ const x = stack.pop(); childFolders(x).forEach(c => { out.push(c.id); stack.push(c.id); }); }
  return out;
}

/* ---------------- permissions ----------------
   A folder with no permission entries on itself, and none inherited from an
   ancestor that has "applicable to subfolders" ticked, is OPEN to every
   signed-in user. As soon as any User/Role/Department is added it becomes
   RESTRICTED to those entities (plus Admin, the folder's creator, and its
   reviewers/approvers). */
function permCount(p){ return p ? (p.users || []).length + (p.roles || []).length + (p.departments || []).length : 0; }
function permMatches(p){
  if(!p) return false;
  const myRoles = getUserRoles(currentUser);
  return (p.users || []).includes(currentUser.uid) ||
    (p.roles || []).some(r => myRoles.includes(r)) ||
    (!!currentUser.department && (p.departments || []).includes(currentUser.department));
}
function governingPermissions(id){
  const chain = folderChain(id); const gov = [];
  chain.forEach((f, idx) => {
    const isSelf = idx === chain.length - 1;
    const p = f.permissions;
    if(permCount(p) > 0 && (isSelf || p.applyToSubfolders !== false)) gov.push(p);
  });
  return gov;
}
function folderWorkflowSource(id){
  const chain = folderChain(id);
  for(let i = chain.length - 1; i >= 0; i--){
    const f = chain[i];
    if((f.reviewers || []).length || (f.approvers || []).length) return f;
  }
  return null;
}
function canAccessFolder(id){
  if(!currentUser) return false;
  if(fmIsAdmin()) return true;
  const f = foldersById.get(id);
  if(!f) return false;
  if(f.createdBy === currentUser.uid) return true;
  const src = folderWorkflowSource(id);
  if(src && [...(src.reviewers || []), ...(src.approvers || [])].includes(currentUser.uid)) return true;
  const gov = governingPermissions(id);
  if(gov.length === 0) return true;
  return gov.some(permMatches);
}
function isFolderRestricted(id){ return governingPermissions(id).length > 0; }
function computeVisibleFolders(){
  const vis = new Set();
  foldersData.forEach(f => { if(canAccessFolder(f.id)) folderChain(f.id).forEach(a => vis.add(a.id)); });
  return vis;
}
// Documents with no folder (uploaded before the File Manager existed) stay
// visible to everyone, exactly as before.
function canAccessDoc(d){
  if(!currentUser) return false;
  if(fmIsAdmin() || !d || !d.folderId) return true;
  if(d.createdBy === currentUser.uid) return true;
  if(!foldersById.has(d.folderId)) return false;
  return canAccessFolder(d.folderId);
}
function folderOptions(onlyAccessible){
  return foldersData
    .filter(f => !onlyAccessible || canAccessFolder(f.id))
    .map(f => ({ id: f.id, path: folderPath(f.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/* ---------------- folder workflow ----------------
   If a folder (or its nearest ancestor) has Reviewers and/or Approvers set
   in Properties, files uploaded there use them: all reviewers (parallel) ->
   all approvers (parallel) -> Published. Otherwise the Document Category
   workflow from Configurations → Workflow Configuration is used, exactly as before. */
function resolveWorkflowForFolder(folderId){
  if(!folderId) return null;
  const src = folderWorkflowSource(folderId);
  if(!src) return null;
  const reviewers = src.reviewers || [], approvers = src.approvers || [];
  const steps = []; let stage = 0;
  if(reviewers.length){
    reviewers.forEach(uid => steps.push({ key: 'rv_' + uid, label: 'Review — ' + userName(uid), role: '', uid, stage,
      fromStatus: 'pending_review', toStatus: approvers.length ? 'pending_approval' : 'approved' }));
    stage++;
  }
  approvers.forEach(uid => steps.push({ key: 'ap_' + uid, label: 'Approval — ' + userName(uid), role: '', uid, stage,
    fromStatus: 'pending_approval', toStatus: 'approved' }));
  return {
    configName: 'Folder: ' + folderPath(src.id),
    initialStatus: reviewers.length ? 'pending_review' : 'pending_approval',
    steps
  };
}
function resolveWorkflowForUpload(folderId, category){
  const byFolder = resolveWorkflowForFolder(folderId);
  if(byFolder) return byFolder;
  const byCategory = category ? resolveWorkflowForCategory(category) : null;
  if(byCategory) return { ...byCategory, initialStatus: 'pending_review' };
  return null;
}
function getUploadWorkflowIssue(folderId, category){
  if(!category) return 'This folder has no reviewers/approvers set, so a Document Category is needed to pick a workflow.';
  return getWorkflowResolutionIssue(category) || 'No workflow could be resolved for this upload.';
}

/* ---------------- upload helpers ---------------- */
function validateUploadFile(file){
  const ext = (file.name.includes('.') ? file.name.split('.').pop() : '').toLowerCase();
  const allowed = String(dmsParams.allowedExtensions || '').split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  if(allowed.length && !allowed.includes(ext)) return `".${ext || '?'}" files aren't allowed. Allowed types: ${allowed.join(', ')} (Configurations → Set Parameter).`;
  const max = Number(dmsParams.maxFileSizeMB) || 0;
  if(max > 0 && file.size > max * 1024 * 1024) return `This file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${max} MB (Configurations → Set Parameter).`;
  return null;
}
function notifySubscribers(folderId, message, docId){
  const uids = new Set();
  folderChain(folderId).forEach(f => (f.subscribers || []).forEach(u => uids.add(u)));
  uids.delete(currentUser.uid);
  const list = [...uids];
  list.forEach(u => notifyUser(u, message, docId));
  if(list.length) queueEmail('subscribedUpload', { uids: list }, message, docId);
}
// Upload lives inside a folder: the folder's Upload button opens this dialog
// with the folder fixed, and Project pre-filled for project folders.
function canUploadToFolder(folderId){
  return canAccessFolder(folderId) && (typeof canAccessPage !== 'function' || canAccessPage('uploadView'));
}
function goUploadToFolder(folderId){
  if(!foldersById.has(folderId)) return;
  if(!canUploadToFolder(folderId)){ toast("You don't have permission to upload to this folder.", 'err'); return; }
  const sel = document.getElementById('fFolder');
  populateFolderSelects();
  if(!sel || ![...sel.options].some(o => o.value === folderId)){ toast("You don't have access to this folder.", 'err'); return; }
  sel.value = folderId;
  document.getElementById('uploadFolderPath').textContent = 'Upload to ' + folderPath(folderId);
  onUploadFolderChange();
  openModal('uploadModalOverlay');
}
function closeUploadModal(){
  closeModal('uploadModalOverlay');
  document.getElementById('uploadForm').reset();
  if(typeof resetUploadForm === 'function') resetUploadForm();
}

/* ---------------- email (Firebase Trigger Email extension) ---------------- */
function queueEmail(kind, target, message, docId){
  if(!emailConfig.enabled) return;
  const flag = { taskAssigned: 'onTaskAssigned', rejected: 'onRejected', published: 'onPublished', subscribedUpload: 'onSubscribedUpload' }[kind];
  if(flag && emailConfig[flag] === false) return;
  const roles = target.roles || [], uids = target.uids || [];
  const emails = [...new Set(usersData
    .filter(u => u.enabled !== false && u.email && (uids.includes(u.id) || getUserRoles(u).some(r => roles.includes(r))))
    .map(u => u.email))];
  if(!emails.length) return;
  sendMailDoc(emails, 'MP DMS — ' + message.slice(0, 110), message, { kind, docId: docId || null });
}
function sendMailDoc(emails, subject, message, extra){
  const link = emailConfig.appUrl ? `<p><a href="${escapeHtml(emailConfig.appUrl)}">Open MP DMS</a></p>` : '';
  const mail = {
    to: emails,
    message: { subject, html: `<p>${escapeHtml(message)}</p>${link}<p style="color:#888;font-size:12px;">Automated message from MP DMS.</p>` },
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: currentUser.uid, ...(extra || {})
  };
  if(emailConfig.fromAddress) mail.from = emailConfig.fromName ? `${emailConfig.fromName} <${emailConfig.fromAddress}>` : emailConfig.fromAddress;
  if(emailConfig.replyTo) mail.replyTo = emailConfig.replyTo;
  return db.collection('mail').add(mail).catch(err => console.error('mail queue:', err));
}

/* ============================================================
   PROJECT FOLDERS — one folder per project, kept in sync
   Runs in an Admin's browser (only Admin may write folders) whenever the
   project list or the folder tree changes. Safe to run repeatedly and from
   several admins at once: a project's folder always has the document ID
   proj_<projectMasterId>, created inside a transaction, so it can never be
   created twice.
     - New project            -> new root folder with the project's name
     - New sub-item (tower)   -> subfolder inside its project's folder
     - Project renamed        -> folder renamed
     - Existing folder with the same name at the same level (made by hand
       before this feature) -> linked to the project instead of duplicated
     - Project deleted        -> folder is KEPT (it may hold files); it just
       stops being a project folder and can then be renamed/deleted
============================================================ */
function projectMasterById(id){ return (mastersData.projectMasters || []).find(p => p.id === id) || null; }
function linkedProjectMaster(folder){ return folder && folder.projectMasterId ? projectMasterById(folder.projectMasterId) : null; }
function projectFolderFor(masterId){ return foldersData.find(f => f.projectMasterId === masterId) || null; }
function onProjectMastersChanged(){
  projectMastersLoaded = true;
  syncProjectFolders();
  if(foldersLoaded){ renderFmTree(); renderFmMain(); }
}
function syncProjectFolders(){
  if(!fmIsAdmin() || !foldersLoaded || !projectMastersLoaded) return;
  const masters = mastersData.projectMasters || [];
  // Top-level projects first so their folders exist before sub-items need them.
  const ordered = [...masters.filter(m => !m.parentId), ...masters.filter(m => m.parentId)];
  ordered.forEach(m => {
    if(projectSyncInFlight.has(m.id)) return;
    const existing = projectFolderFor(m.id);
    if(existing){
      if(existing.name !== m.name && !folderNameIssue(m.name, existing.parentId || null, existing.id)){
        projectSyncInFlight.add(m.id);
        db.collection('folders').doc(existing.id).update({ name: m.name, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
          .catch(err => console.error('project folder rename:', err))
          .finally(() => projectSyncInFlight.delete(m.id));
      }
      return;
    }
    let parentFolderId = null;
    if(m.parentId){
      const parentFolder = projectFolderFor(m.parentId);
      if(!parentFolder) return; // parent's folder not created yet — next snapshot will retry
      parentFolderId = parentFolder.id;
    }
    // Adopt a hand-made folder with the same name at the same level
    const sameName = childFolders(parentFolderId).find(f => !linkedProjectMaster(f) && f.name.trim().toLowerCase() === m.name.trim().toLowerCase());
    projectSyncInFlight.add(m.id);
    let p;
    if(sameName){
      p = db.collection('folders').doc(sameName.id).update({ projectMasterId: m.id, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    } else {
      const ref = db.collection('folders').doc('proj_' + m.id);
      const counterRef = db.collection('counters').doc('folders');
      p = db.runTransaction(tx => Promise.all([tx.get(ref), tx.get(counterRef)]).then(([snap, cSnap]) => {
        if(snap.exists) return; // another admin got there first
        const n = cSnap.exists ? (cSnap.data().next || 1) : 1;
        tx.set(counterRef, { next: n + 1 });
        const now = firebase.firestore.FieldValue.serverTimestamp();
        tx.set(ref, {
          name: m.name, parentId: parentFolderId, folderNo: n, projectMasterId: m.id,
          description: m.parentId ? 'Created automatically for this project sub-item.' : 'Created automatically for this project.',
          permissions: { users: [], roles: [], departments: [], applyToSubfolders: true },
          reviewers: [], approvers: [], subscribers: [],
          createdBy: currentUser.uid, createdByName: 'Auto (Project Master)', createdAt: now, updatedAt: now
        });
      }));
    }
    p.catch(err => console.error('project folder sync:', err)).finally(() => projectSyncInFlight.delete(m.id));
  });
}
// The project a folder belongs to (nearest project folder up the chain),
// used to pre-fill Project on the Upload form.
function projectNameForFolder(folderId){
  const chain = folderChain(folderId);
  for(let i = 0; i < chain.length; i++){
    const m = linkedProjectMaster(chain[i]);
    if(m && !m.parentId) return m.name;
  }
  return '';
}
// Upload form: picking a folder fills Project; picking a Project with no folder chosen fills Folder.
function onUploadFolderChange(){
  const folderId = document.getElementById('fFolder').value;
  const projSel = document.getElementById('fProject');
  const projName = folderId ? projectNameForFolder(folderId) : '';
  if(projName && projSel && [...projSel.options].some(o => o.value === projName)) projSel.value = projName;
  updateUploadWorkflowHint();
}
function onUploadProjectChange(){
  const folderSel = document.getElementById('fFolder');
  const name = document.getElementById('fProject').value;
  if(!folderSel || folderSel.value || !name) return;
  const master = (mastersData.projectMasters || []).find(p => !p.parentId && p.name === name);
  const folder = master ? projectFolderFor(master.id) : null;
  if(folder && canAccessFolder(folder.id)){ folderSel.value = folder.id; updateUploadWorkflowHint(); }
}

/* ============================================================
   LISTENERS
============================================================ */
function startFilesListeners(){
  stopFilesListeners();
  fmFilesUnsubs.push(db.collection('folders').onSnapshot(snap => {
    foldersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    foldersById = new Map(foldersData.map(f => [f.id, f]));
    foldersLoaded = true;
    onFoldersChanged();
  }, err => { console.error('folders listener:', err); foldersLoaded = true; renderFmTree(); }));

  fmFilesUnsubs.push(db.collection('userPrefs').doc(currentUser.uid).onSnapshot(snap => {
    const d = snap.exists ? snap.data() : {};
    myPrefs = { quickLinks: d.quickLinks || [] };
    prefsLoaded = true;
    renderFmLinksPanel();
    if(fmActiveFolderId) renderFmMain();
  }, err => { console.error('userPrefs listener:', err); prefsLoaded = true; }));

  fmFilesUnsubs.push(db.collection('dmsSettings').doc('params').onSnapshot(snap => {
    dmsParams = { ...DEFAULT_DMS_PARAMS, ...(snap.exists ? snap.data() : {}) };
    if(!fmViewActive('setParamView')) fillSetParamForm();
    renderQueue();
    renderFmMain();
  }, err => console.error('dmsSettings/params listener:', err)));

  fmFilesUnsubs.push(db.collection('dmsSettings').doc('email').onSnapshot(snap => {
    emailConfig = { ...DEFAULT_EMAIL_CONFIG, ...(snap.exists ? snap.data() : {}) };
    if(!fmViewActive('emailConfigView')) fillEmailConfigForm();
  }, err => console.error('dmsSettings/email listener:', err)));
}

function stopFilesListeners(){
  fmFilesUnsubs.forEach(u => { try{ u(); }catch(e){} });
  fmFilesUnsubs = [];
  if(fmFolderDocsUnsub){ try{ fmFolderDocsUnsub(); }catch(e){} fmFolderDocsUnsub = null; }
  foldersData = []; foldersById = new Map(); foldersLoaded = false;
  myPrefs = { quickLinks: [] }; prefsLoaded = false;
  projectSyncInFlight = new Set();
  fmActiveFolderId = null; fmExpanded = new Set(); fmTreeFilter = ''; fmFolderDocs = null;
  fmKmOpen = new Set(['pendReview', 'pendApproval']); fmOverdueOnly = false; fmPendingFolderId = null; fmSearchState = null; fmLinksPanel = null; fmShowAllDocs = false;
  fmReportRows = null; fmActiveReport = null; fmMoveCandidates = []; fmTransferFrom = null;
  dmsParams = { ...DEFAULT_DMS_PARAMS }; emailConfig = { ...DEFAULT_EMAIL_CONFIG };
}

function onFoldersChanged(){
  syncProjectFolders();
  if(fmActiveFolderId && !foldersById.has(fmActiveFolderId)) openFmDashboard({ history: 'replace' });
  if(fmPendingFolderId){
    const pid = fmPendingFolderId; fmPendingFolderId = null;
    if(foldersById.has(pid)) openFmFolder(pid, { history: 'none', noSwitch: !fmViewActive('filesView') });
    else if(fmViewActive('filesView')) openFmDashboard({ history: 'replace' });
  }
  renderFmTree();
  renderFmLinksPanel();
  renderFmMain();
  populateFolderSelects();
  renderRootFolderView();
  updateUploadWorkflowHint();
  renderDocsTable();
  if(fmActiveReport === 'approvers') runFolderApproverReport();
}
// Called by app-workflow.js whenever the approval queue data changes.
function onQueueDataChanged(){
  if(!fmActiveFolderId && !fmSearchState) renderFmMain();
  renderAlerts();
}
// Called by app-workflow.js when the users list changes.
function onFmUsersChanged(){
  populateFolderSelects();
  renderFmMain();
  renderAlerts();
}
// Hook from switchView() in index.html
function onFmViewShown(viewId){
  if(viewId === 'filesView'){ renderFmTree(); renderFmMain(); }
  if(viewId === 'setParamView') fillSetParamForm();
  if(viewId === 'emailConfigView') fillEmailConfigForm();
  if(viewId === 'alertsView') renderAlerts();
  if(viewId === 'rootFolderView') renderRootFolderView();
  if(viewId === 'moveFilesView') populateFolderSelects();
  if(viewId === 'importDocsView'){ populateImportDest(); imRenderPreview(); }
  if(viewId === 'transferRightsView') populateTransferUserSelects();
}

/* ============================================================
   FILES VIEW — tree
============================================================ */
function renderFmTree(){
  const el = document.getElementById('fmTree');
  if(!el) return;
  if(!foldersLoaded){ el.innerHTML = '<div class="master-empty">Loading&hellip;</div>'; return; }
  if(foldersData.length === 0){
    el.innerHTML = `<div class="master-empty">No folders yet.${fmIsAdmin() ? `<br>Root folders are created from projects.<br><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="switchView('projectsMasterView')">+ Add a project</button>` : ''}</div>`;
    return;
  }
  const vis = computeVisibleFolders();
  const q = fmTreeFilter.trim().toLowerCase();
  if(q){
    const hits = foldersData.filter(f => vis.has(f.id) && f.name.toLowerCase().includes(q))
      .map(f => ({ f, path: folderPath(f.id) })).sort((a, b) => a.path.localeCompare(b.path));
    el.innerHTML = hits.length
      ? hits.map(h => `<div class="fm-node ${h.f.id === fmActiveFolderId ? 'active' : ''}" onclick="openFmFolder('${h.f.id}')"><span class="fm-caret"></span>${FOLDER_SVG}<span class="fm-node-name" title="${escapeHtml(h.path)}">${escapeHtml(h.path)}</span></div>`).join('')
      : '<div class="master-empty">No folders match.</div>';
    return;
  }
  const level = (parentId, depth) => childFolders(parentId).filter(f => vis.has(f.id)).map(f => {
    const kids = childFolders(f.id).filter(c => vis.has(c.id));
    const open = fmExpanded.has(f.id);
    const dim = !canAccessFolder(f.id);
    return `<div class="fm-node ${f.id === fmActiveFolderId ? 'active' : ''} ${dim ? 'dim' : ''}" style="padding-left:${8 + depth * 16}px;" onclick="openFmFolder('${f.id}')">
        <span class="fm-caret" onclick="event.stopPropagation(); toggleFmNode('${f.id}')">${kids.length ? (open ? '&#9662;' : '&#9656;') : ''}</span>${FOLDER_SVG}<span class="fm-node-name">${escapeHtml(f.name)}</span>
      </div>` + (open ? level(f.id, depth + 1) : '');
  }).join('');
  el.innerHTML = level(null, 0) || `<div class="master-empty">You don't have access to any folders yet.</div>`;
}
function toggleFmNode(id){ if(fmExpanded.has(id)) fmExpanded.delete(id); else fmExpanded.add(id); renderFmTree(); }
function onFmTreeFilter(v){ fmTreeFilter = v; renderFmTree(); }

function openFmFolder(id, opts){
  opts = opts || {};
  if(!foldersById.has(id)){
    if(!foldersLoaded){ fmPendingFolderId = id; showFilesView(); fmHistory(opts, { folder: id }, '#folder=' + encodeURIComponent(id)); } // open once folders load
    return;
  }
  fmSearchState = null; fmLinksPanel = null; fmShowAllDocs = false;
  fmActiveFolderId = id;
  folderChain(id).slice(0, -1).forEach(a => fmExpanded.add(a.id));
  if(fmFolderDocsUnsub){ fmFolderDocsUnsub(); fmFolderDocsUnsub = null; }
  fmFolderDocs = null;
  if(canAccessFolder(id)){
    fmFolderDocsUnsub = db.collection('documents').where('folderId', '==', id).onSnapshot(snap => {
      if(fmActiveFolderId !== id) return;
      fmFolderDocs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.updatedAt) - tsMs(a.updatedAt));
      renderFmMain();
    }, err => { console.error('folder documents listener:', err); fmFolderDocs = []; renderFmMain(); });
  } else {
    fmFolderDocs = [];
  }
  if(!opts.noSwitch) showFilesView();
  fmHistory(opts, { folder: id }, '#folder=' + encodeURIComponent(id));
  renderFmTree(); renderFmLinksPanel(); renderFmMain();
}
// Files > All Documents — the full documents table (formerly its own page)
function openFmAllDocs(opts){
  fmSearchState = null; fmActiveFolderId = null; fmLinksPanel = null; fmShowAllDocs = true; fmPendingFolderId = null;
  if(fmFolderDocsUnsub){ fmFolderDocsUnsub(); fmFolderDocsUnsub = null; }
  fmFolderDocs = null;
  showFilesView();
  fmHistory(opts, { view: 'filesView', alldocs: true }, '#alldocs');
  renderFmTree(); renderFmLinksPanel(); renderFmMain();
}
function openFmDashboard(opts){
  fmSearchState = null; fmActiveFolderId = null; fmLinksPanel = null; fmShowAllDocs = false; fmPendingFolderId = null;
  if(fmFolderDocsUnsub){ fmFolderDocsUnsub(); fmFolderDocsUnsub = null; }
  fmFolderDocs = null;
  showFilesView();
  fmHistory(opts, { view: 'filesView' }, '#filesView');
  renderFmTree(); renderFmLinksPanel(); renderFmMain();
}

/* ============================================================
   FILES VIEW — right pane
============================================================ */
function renderFmMain(){
  const el = document.getElementById('fmMain');
  if(!el || !currentUser) return;
  const docsPanel = document.getElementById('fmDocsPanel');
  const allNode = document.getElementById('fmAllDocsNode');
  if(docsPanel) docsPanel.classList.toggle('hidden', !fmShowAllDocs);
  if(allNode) allNode.classList.toggle('active', fmShowAllDocs);
  el.classList.toggle('hidden', fmShowAllDocs);
  if(fmShowAllDocs){ renderDocsTable(); return; }
  if(fmSearchState) return renderFmSearchResults(el);
  if(fmActiveFolderId && foldersById.has(fmActiveFolderId)) return renderFmFolder(el);
  renderFmDashboard(el);
}

// --- Knowledge Management dashboard ---
function stepIsMine(v){
  return (v.steps || []).some(s => s.stage === v.currentStage && s.decision === 'pending' && isStepAssignedToMe(s));
}
function kmBuckets(){
  const me = currentUser.uid;
  const all = [...queueMap.values()].filter(v => canAccessDoc({ folderId: v.docFolderId, createdBy: v.uploadedBy }))
    .filter(v => !fmOverdueOnly || isOverdue(v));
  // Pending Review / Approval = items you can act on: assigned to you, or (Admin) anyone's
  const actionable = new Set(myActionableVersions().map(v => v.id));
  return [
    { key: 'myReview',     label: 'My files under Review',      items: all.filter(v => v.uploadedBy === me && v.status === 'pending_review') },
    { key: 'myApproval',   label: 'My files awaiting Approval',  items: all.filter(v => v.uploadedBy === me && v.status === 'pending_approval') },
    { key: 'pendReview',   label: 'Pending Review',              items: all.filter(v => v.status === 'pending_review' && actionable.has(v.id)), act: true },
    { key: 'pendApproval', label: 'Pending Approval',            items: all.filter(v => v.status === 'pending_approval' && actionable.has(v.id)), act: true }
  ];
}
function renderKmStats(){
  const mine = myActionableVersions();
  const overdue = mine.filter(isOverdue).length;
  const published = allDocsSnapshot.filter(d => d.status === 'published' && canAccessDoc(d)).length;
  return `<div class="stat-row km-stats">
    <div class="stat-card accent-gold"><div class="num">${mine.length}</div><div class="lbl">Awaiting your action</div></div>
    <div class="stat-card accent-red clickable ${fmOverdueOnly ? 'stat-active' : ''}" onclick="toggleKmOverdueOnly()" title="Show only overdue items"><div class="num">${overdue}</div><div class="lbl">Overdue (past TAT)${fmOverdueOnly ? ' &middot; showing only these' : ''}</div></div>
    <div class="stat-card accent-teal clickable" onclick="goToDocumentsFiltered('')" title="Open All Documents"><div class="num">${queueMap.size}</div><div class="lbl">Active in the workflow</div></div>
    <div class="stat-card clickable" onclick="goToDocumentsFiltered('published')" title="Open All Documents &mdash; Published"><div class="num">${published}</div><div class="lbl">Published documents</div></div>
  </div>`;
}
function toggleKmOverdueOnly(){ fmOverdueOnly = !fmOverdueOnly; renderFmMain(); }
function renderFmDashboard(el){
  const buckets = kmBuckets();
  const allOpen = buckets.every(b => fmKmOpen.has(b.key));
  el.innerHTML = `
    ${renderKmStats()}
    <div class="fm-section-head">
      <h3>Knowledge Management</h3>
      <button class="fm-link" onclick="toggleKmAll()">${allOpen ? 'Collapse All &minus;' : 'Expand All +'}</button>
    </div>
    ${fmOverdueOnly ? `<div class="km-filter-note">Showing overdue items only. <button class="fm-link" onclick="toggleKmOverdueOnly()">Show all</button></div>` : ''}
    ${buckets.map(b => {
      const open = fmKmOpen.has(b.key);
      return `<div class="km-row" onclick="toggleKm('${b.key}')">${FOLDER_SVG_LG}<span class="km-label">${b.label}</span><span class="km-count">${b.items.length}</span><span class="km-toggle">${open ? '&minus;' : '+'}</span></div>` +
        (open ? `<div class="km-body">${kmItemsTable(b.items, b.act)}</div>` : '');
    }).join('')}`;
}
function kmItemsTable(items, withActions){
  if(!items.length) return '<div class="fm-empty-note">Nothing here right now.</div>';
  const sorted = [...items].sort((a, b) => stageStartMs(a) - stageStartMs(b));
  const assignee = s => s.uid ? userName(s.uid) : (ROLE_LABELS[s.role] || s.role);
  return `<table class="fm-table"><thead><tr><th>Drawing No.</th><th>Title</th><th>Folder</th><th>Uploaded By</th><th>Waiting</th>${withActions ? '<th></th>' : '<th>With</th>'}</tr></thead><tbody>
    ${sorted.map(v => {
      const pending = (v.steps || []).filter(s => s.stage === v.currentStage && s.decision === 'pending');
      const step = withActions ? myActionStep(v) : null;
      const onBehalf = step && !isStepAssignedToMe(step);
      const maxStage = Math.max(...(v.steps || []).map(s => s.stage));
      const chips = (v.steps || []).map(s => {
        let cls = 'pending';
        if(s.decision === 'approved') cls = 'approved';
        else if(s.decision === 'rejected') cls = 'rejected';
        else if(s.stage === v.currentStage) cls = 'active-pending';
        return `<span class="step-chip ${cls}">${escapeHtml(s.label)}</span>`;
      }).join('');
      return `<tr onclick="openDocumentDetail('${v.docId}')">
        <td><span class="drawing-code">${escapeHtml(v.docDrawingNumber || '—')}</span></td>
        <td>${escapeHtml(v.docTitle || '—')}${isOverdue(v) ? ' <span class="overdue-tag">Overdue</span>' : ''}
          ${withActions && step ? `<div class="km-step">Your step: <b>${escapeHtml(step.label)}</b>${onBehalf ? ` &middot; on behalf of ${escapeHtml(assignee(step))}` : ''}</div>` : ''}
          <div class="step-chip-row" style="margin-top:5px;">${chips}</div></td>
        <td>${escapeHtml(v.docFolderId ? folderPath(v.docFolderId) : '—')}</td>
        <td>${escapeHtml(v.uploadedByName || '—')}</td>
        <td>${timeAgoMs(stageStartMs(v))}</td>
        ${withActions && step ? `<td onclick="event.stopPropagation();"><div class="km-actions">
            <button class="btn btn-teal btn-sm" onclick="openDecisionModal('${v.docId}','${v.id}','${step.key}','approved','${escapeJs(step.label)}',${step.stage === maxStage})">Approve</button>
            <button class="btn btn-red btn-sm" onclick="openDecisionModal('${v.docId}','${v.id}','${step.key}','rejected','${escapeJs(step.label)}',${step.stage === maxStage})">Reject</button>
          </div></td>`
          : `<td>${escapeHtml(pending.map(assignee).join(', ') || '—')}</td>`}
      </tr>`;
    }).join('')}</tbody></table>`;
}
function toggleKm(key){ if(fmKmOpen.has(key)) fmKmOpen.delete(key); else fmKmOpen.add(key); renderFmMain(); }
function toggleKmAll(){
  const keys = ['myReview', 'myApproval', 'pendReview', 'pendApproval'];
  const allOpen = keys.every(k => fmKmOpen.has(k));
  fmKmOpen = allOpen ? new Set() : new Set(keys);
  renderFmMain();
}

// --- Folder page ---
function renderFmFolder(el){
  const id = fmActiveFolderId;
  const f = foldersById.get(id);
  const chain = folderChain(id);
  const access = canAccessFolder(id);
  const restricted = isFolderRestricted(id);
  const wf = folderWorkflowSource(id);
  const vis = computeVisibleFolders();
  const subs = childFolders(id).filter(c => vis.has(c.id));
  const isQuick = myPrefs.quickLinks.includes(id);
  const isSub = (f.subscribers || []).includes(currentUser.uid);

  const crumbs = `<a onclick="openFmDashboard()">Home</a> / ` + chain.map(c => c.id === id ? `<b>${escapeHtml(c.name)}</b>` : `<a onclick="openFmFolder('${c.id}')">${escapeHtml(c.name)}</a>`).join(' / ');
  const wfText = wf
    ? `${(wf.reviewers || []).length} reviewer(s) &rarr; ${(wf.approvers || []).length} approver(s)${wf.id !== id ? ` <span class="fm-muted">(inherited from ${escapeHtml(folderPath(wf.id))})</span>` : ''}`
    : 'Document Category workflow';
  const actionLinks = `<div class="fm-actions-links">
      ${!fmIsAdmin() && canCreateSubfolderIn(id) ? `<a onclick="openCreateFolderModal('${id}')">New Subfolder</a><span class="sep">|</span>` : ''}
      ${fmIsAdmin() ? `<a onclick="openFolderPermModal('${id}')">Permissions</a><span class="sep">|</span>
      <a onclick="openCreateFolderModal('${id}')">New Subfolder</a><span class="sep">|</span>
      <a onclick="goImportToFolder('${id}')">Import Old Files</a><span class="sep">|</span>
      <a class="danger" onclick="deleteFolder('${id}')">Delete Folder</a><span class="sep">|</span>` : ''}
      <a onclick="toggleQuickLink('${id}')">${isQuick ? '&#9733; Remove Quick Link' : '&#9734; Add to Quick Links'}</a>
    </div>`;

  let filesHtml;
  if(!access){
    filesHtml = `<div class="fm-empty-note">You don't have access to the files in this folder. Ask an Admin to add you under Permissions.</div>`;
  } else if(fmFolderDocs === null){
    filesHtml = `<div class="fm-empty-note">Loading files&hellip;</div>`;
  } else if(fmFolderDocs.length === 0){
    filesHtml = `<div class="fm-empty-note">No files in this folder yet.${canUploadToFolder(id) ? ` Click <b>+ Upload</b> to add one.` : ''}</div>`;
  } else {
    filesHtml = `<table class="fm-table"><thead><tr><th>Drawing No.</th><th>Title</th><th>File</th><th>Version</th><th>Status</th><th>Uploaded By</th><th>Updated</th><th></th></tr></thead><tbody>
      ${fmFolderDocs.map(d => `<tr onclick="openDocumentDetail('${d.id}')">
        <td><span class="drawing-code">${escapeHtml(d.drawingNumber || '—')}</span></td>
        <td>${escapeHtml(d.title || '—')}</td>
        <td class="fm-file-cell">${escapeHtml(d.currentFileName || '—')}</td>
        <td>v${d.currentVersionNo || 1}${d.currentRevision ? ` <span class="fm-muted">${escapeHtml(d.currentRevision)}</span>` : ''}</td>
        <td><span class="badge st-${d.status}"><span class="dot"></span>${escapeHtml(STATUS_LABELS[d.status] || d.status)}</span></td>
        <td>${escapeHtml(d.createdByName || '—')}</td>
        <td>${timeAgo(d.updatedAt)}</td>
        <td style="text-align:right;">${d.currentFileURL ? `<a class="fm-open" href="${escapeHtml(d.currentFileURL)}" target="_blank" rel="noopener" onclick="event.stopPropagation();">Open &#8599;</a>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  el.innerHTML = `
    <div class="fm-crumb">${crumbs}</div>
    <div class="fm-folder-head">
      ${FOLDER_SVG_LG}
      <h3>${escapeHtml(folderPath(id))}</h3>
      <div class="fm-folder-btns">
        ${fmIsAdmin() ? `<button class="btn btn-orange btn-sm" onclick="openFolderPropsModal('${id}')">+ Properties</button>` : ''}
        <button class="btn ${isSub ? 'btn-outline-orange' : 'btn-orange'} btn-sm" onclick="toggleSubscribe('${id}')">${isSub ? '&#10003; Subscribed' : '&#8801; Subscribe'}</button>
        ${canUploadToFolder(id) ? `<button class="btn btn-orange btn-sm" onclick="goUploadToFolder('${id}')">+ Upload</button>` : ''}
      </div>
    </div>
    <div class="fm-meta">
      Folder Number : <b>${fmtFolderNo(f.folderNo)}</b>
      ${linkedProjectMaster(f) ? `<span class="fm-tag project">&#127959; Project folder</span>` : ''}
      <span class="fm-tag ${restricted ? 'restricted' : 'open'}">${restricted ? 'Restricted' : 'Open to all users'}</span>
      <span>Workflow: ${wfText}</span>
    </div>
    ${f.description ? `<div class="fm-desc">${escapeHtml(f.description)}</div>` : ''}
    ${actionLinks}
    ${subs.length ? `<div class="fm-subhead">Folders</div><div class="fm-sub-grid">${subs.map(s => `<div class="fm-sub" onclick="openFmFolder('${s.id}')">${FOLDER_SVG}<span>${escapeHtml(s.name)}</span></div>`).join('')}</div>` : ''}
    <div class="fm-subhead">Files${access && fmFolderDocs ? ` (${fmFolderDocs.length})` : ''}</div>
    ${filesHtml}`;
}

/* ---------------- quick links / subscriptions / default ---------------- */
function toggleQuickLink(id){
  const on = myPrefs.quickLinks.includes(id);
  db.collection('userPrefs').doc(currentUser.uid).set({
    quickLinks: on ? firebase.firestore.FieldValue.arrayRemove(id) : firebase.firestore.FieldValue.arrayUnion(id)
  }, { merge: true })
    .then(() => toast(on ? 'Removed from My Quick Links.' : 'Added to My Quick Links.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function toggleSubscribe(id){
  const f = foldersById.get(id); if(!f) return;
  const on = (f.subscribers || []).includes(currentUser.uid);
  db.collection('folders').doc(id).update({
    subscribers: on ? firebase.firestore.FieldValue.arrayRemove(currentUser.uid) : firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
  })
    .then(() => toast(on ? 'Unsubscribed.' : "Subscribed — you'll be notified when files are added here or in its subfolders.", 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function toggleFmLinksPanel(which){
  fmLinksPanel = fmLinksPanel === which ? null : which;
  renderFmLinksPanel();
}
function renderFmLinksPanel(){
  const el = document.getElementById('fmLinksPanel');
  if(!el) return;
  if(!fmLinksPanel || !currentUser){ el.classList.add('hidden'); return; }
  const ids = fmLinksPanel === 'quick'
    ? myPrefs.quickLinks.filter(id => foldersById.has(id))
    : foldersData.filter(f => (f.subscribers || []).includes(currentUser.uid)).map(f => f.id);
  const title = fmLinksPanel === 'quick' ? 'My Quick Links' : 'Subscribed Folders';
  el.innerHTML = `<div class="fm-pop-head">${title}<button class="modal-close" onclick="toggleFmLinksPanel(null)">&times;</button></div>` +
    (ids.length
      ? ids.map(id => `<div class="fm-node" onclick="openFmFolder('${id}')">${FOLDER_SVG}<span class="fm-node-name">${escapeHtml(folderPath(id))}</span></div>`).join('')
      : `<div class="fm-empty-note" style="padding:12px 14px;">${fmLinksPanel === 'quick' ? 'Open a folder and click &#9734; Quick Link to pin it here.' : 'Open a folder and click Subscribe to follow it.'}</div>`);
  el.classList.remove('hidden');
}

/* ---------------- search ---------------- */
function fmQuickSearch(){
  const kw = document.getElementById('fmSearchInput').value.trim();
  if(!kw){ toast('Type a drawing number, title, file name, project or category to search.', 'err'); return; }
  runFmSearch({ keyword: kw }, `"${kw}"`);
}
function docMatchesCrit(d, c){
  if(c.keyword){
    const hay = [d.title, d.drawingNumber, d.currentFileName, d.project, d.category, d.department, d.createdByName].join(' ').toLowerCase();
    if(!c.keyword.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  if(c.folderId){
    if(c.folderId === UNFILED){ if(d.folderId) return false; }
    else {
      const ok = d.folderId === c.folderId || (c.includeSub && descendantIds(c.folderId).includes(d.folderId));
      if(!ok) return false;
    }
  }
  if(c.project && d.project !== c.project) return false;
  if(c.department && d.department !== c.department) return false;
  if(c.category && d.category !== c.category) return false;
  if(c.status && d.status !== c.status) return false;
  if(c.uploadedBy && d.createdBy !== c.uploadedBy) return false;
  const ms = tsMs(d.createdAt);
  if(c.from && ms < new Date(c.from + 'T00:00:00').getTime()) return false;
  if(c.to && ms > new Date(c.to + 'T23:59:59').getTime()) return false;
  return true;
}
function runFmSearch(crit, label, opts){
  fmSearchState = { crit, label, results: null };
  fmShowAllDocs = false; fmActiveFolderId = null; fmPendingFolderId = null;
  fmLinksPanel = null; renderFmLinksPanel();
  showFilesView();
  fmHistory(opts, { view: 'filesView', search: true, crit, label }, '#search');
  renderFmMain();
  fetchAllDocuments().then(docs => {
    if(!fmSearchState || fmSearchState.crit !== crit) return;
    fmSearchState.results = docs.filter(d => canAccessDoc(d) && docMatchesCrit(d, crit));
    renderFmMain();
  }).catch(err => { toast('Search failed: ' + err.message, 'err'); fmSearchState = null; renderFmMain(); });
}
function renderFmSearchResults(el){
  const s = fmSearchState;
  const body = s.results === null
    ? '<div class="fm-empty-note">Searching&hellip;</div>'
    : (s.results.length === 0 ? '<div class="fm-empty-note">No files match.</div>' :
      `<table class="fm-table"><thead><tr><th>Drawing No.</th><th>Title</th><th>Folder</th><th>Project</th><th>Status</th><th>Uploaded By</th><th>Updated</th></tr></thead><tbody>
        ${s.results.map(d => `<tr onclick="openDocumentDetail('${d.id}')">
          <td><span class="drawing-code">${escapeHtml(d.drawingNumber || '—')}</span></td>
          <td>${escapeHtml(d.title || '—')}</td>
          <td>${escapeHtml(folderPath(d.folderId))}</td>
          <td>${escapeHtml(d.project || '—')}</td>
          <td><span class="badge st-${d.status}"><span class="dot"></span>${escapeHtml(STATUS_LABELS[d.status] || d.status)}</span></td>
          <td>${escapeHtml(d.createdByName || '—')}</td>
          <td>${timeAgo(d.updatedAt)}</td>
        </tr>`).join('')}</tbody></table>`);
  el.innerHTML = `
    <div class="fm-section-head">
      <h3>Search results ${s.results ? `<span class="fm-muted">(${s.results.length})</span>` : ''}</h3>
      <button class="fm-link" onclick="openFmDashboard()">&larr; Back</button>
    </div>
    <div class="fm-meta" style="margin-bottom:12px;">For ${escapeHtml(s.label)}</div>
    ${body}`;
}
function openAdvancedSearchModal(){
  const opts = (items, placeholder) => `<option value="">${placeholder}</option>` + items.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  const folderItems = folderOptions(true).map(o => [o.id, o.path]);
  folderItems.unshift([UNFILED, '(Unfiled — uploaded before folders)']);
  document.getElementById('asFolder').innerHTML = opts(folderItems, 'Any folder');
  document.getElementById('asProject').innerHTML = opts(mastersData.projectMasters.filter(p => !p.parentId).map(p => [p.name, p.name]), 'Any project');
  document.getElementById('asDepartment').innerHTML = opts(mastersData.departmentMasters.filter(p => !p.parentId).map(p => [p.name, p.name]), 'Any department');
  document.getElementById('asCategory').innerHTML = opts(mastersData.categoryMasters.filter(p => !p.parentId).map(p => [p.name, p.name]), 'Any category');
  document.getElementById('asStatus').innerHTML = opts(Object.entries(STATUS_LABELS), 'Any status');
  document.getElementById('asUploadedBy').innerHTML = opts(usersData.map(u => [u.id, u.name]), 'Anyone');
  document.getElementById('asKeyword').value = document.getElementById('fmSearchInput').value.trim();
  openModal('advSearchModalOverlay');
}
function submitAdvancedSearch(){
  const g = id => document.getElementById(id).value;
  const crit = {
    keyword: g('asKeyword').trim(), folderId: g('asFolder'), includeSub: document.getElementById('asIncludeSub').checked,
    project: g('asProject'), department: g('asDepartment'), category: g('asCategory'), status: g('asStatus'),
    uploadedBy: g('asUploadedBy'), from: g('asFrom'), to: g('asTo')
  };
  const parts = [];
  if(crit.keyword) parts.push(`"${crit.keyword}"`);
  if(crit.folderId) parts.push('folder ' + (crit.folderId === UNFILED ? '(Unfiled)' : folderPath(crit.folderId)) + (crit.includeSub ? ' + subfolders' : ''));
  ['project', 'department', 'category'].forEach(k => { if(crit[k]) parts.push(k + ' ' + crit[k]); });
  if(crit.status) parts.push('status ' + (STATUS_LABELS[crit.status] || crit.status));
  if(crit.uploadedBy) parts.push('uploaded by ' + userName(crit.uploadedBy));
  if(crit.from || crit.to) parts.push(`uploaded ${crit.from || '…'} to ${crit.to || '…'}`);
  closeModal('advSearchModalOverlay');
  runFmSearch(crit, parts.join(', ') || 'all files');
}

/* ============================================================
   FOLDER CREATE / RENAME / DELETE
============================================================ */
function allocateFolderNo(){
  const ref = db.collection('counters').doc('folders');
  return db.runTransaction(tx => tx.get(ref).then(s => {
    const n = s.exists ? (s.data().next || 1) : 1;
    tx.set(ref, { next: n + 1 });
    return n;
  }));
}
// Admin anywhere; other users need "Create subfolders" in User Access and access to the folder.
function canCreateSubfolderIn(parentId){
  if(!parentId || !currentUser) return false;
  if(fmIsAdmin()) return true;
  return canAccessFolder(parentId) && typeof canAccessPage === 'function' && canAccessPage('createFolder');
}
function openCreateFolderModal(parentId){
  if(!parentId){ toast('Root folders are created from projects. Add the project in Masters → Project Master and its folder appears automatically.', 'err'); return; }
  if(!canCreateSubfolderIn(parentId)){ toast("You don't have permission to create subfolders here. Ask an Admin (Configurations → User Access → Create subfolders).", 'err'); return; }
  fmFolderModal = { mode: 'create', parentId: parentId || null };
  document.getElementById('cfTitle').textContent = parentId ? 'New Subfolder' : 'Create Root Folder';
  document.getElementById('cfParent').textContent = parentId ? 'Inside: ' + folderPath(parentId) : 'Top level (root folder)';
  document.getElementById('cfName').value = '';
  document.getElementById('cfConfirmBtn').textContent = 'Create';
  openModal('createFolderModalOverlay');
  setTimeout(() => document.getElementById('cfName').focus(), 0);
}
function openRenameFolderModal(id){
  const f = foldersById.get(id); if(!f) return;
  const pm = linkedProjectMaster(f);
  if(pm){ toast(`"${f.name}" is a project folder — rename the project in Masters → Project Master and the folder follows.`, 'err'); return; }
  fmFolderModal = { mode: 'rename', folderId: id, parentId: f.parentId || null };
  document.getElementById('cfTitle').textContent = 'Rename Folder';
  document.getElementById('cfParent').textContent = 'Current path: ' + folderPath(id);
  document.getElementById('cfName').value = f.name;
  document.getElementById('cfConfirmBtn').textContent = 'Save';
  openModal('createFolderModalOverlay');
  setTimeout(() => { const el = document.getElementById('cfName'); el.focus(); el.select(); }, 0);
}
function folderNameIssue(name, parentId, excludeId){
  if(!name) return 'Please enter a folder name.';
  if(/[\/\\]/.test(name)) return 'Folder names can\'t contain / or \\.';
  if(name.length > 80) return 'Folder name is too long (80 characters max).';
  const dup = childFolders(parentId).some(f => f.id !== excludeId && f.name.toLowerCase() === name.toLowerCase());
  return dup ? 'A folder with that name already exists here.' : null;
}
function submitCreateFolder(){
  const m = fmFolderModal; if(!m) return;
  const name = document.getElementById('cfName').value.trim();
  const issue = folderNameIssue(name, m.parentId, m.folderId);
  if(issue){ toast(issue, 'err'); return; }
  if(m.mode !== 'rename' && !m.parentId){ toast('Root folders are created from projects (Masters → Project Master).', 'err'); return; }
  if(m.mode !== 'rename' && !canCreateSubfolderIn(m.parentId)){ toast("You don't have permission to create subfolders here.", 'err'); return; }
  if(m.mode === 'rename' && !fmIsAdmin()){ toast('Only Admin can rename folders.', 'err'); return; }
  const btn = document.getElementById('cfConfirmBtn');
  btn.disabled = true;
  const now = firebase.firestore.FieldValue.serverTimestamp();
  const p = m.mode === 'rename'
    ? db.collection('folders').doc(m.folderId).update({ name, updatedAt: now })
    : allocateFolderNo().then(no => db.collection('folders').add({
        name, parentId: m.parentId, folderNo: no, description: '',
        permissions: { users: [], roles: [], departments: [], applyToSubfolders: true },
        reviewers: [], approvers: [], subscribers: [],
        createdBy: currentUser.uid, createdByName: currentUser.name, createdAt: now, updatedAt: now
      }));
  p.then(() => {
    if(m.parentId) fmExpanded.add(m.parentId);
    toast(m.mode === 'rename' ? 'Folder renamed.' : 'Folder created.', 'ok');
    closeModal('createFolderModalOverlay');
  }).catch(err => toast('Could not save: ' + err.message, 'err'))
    .finally(() => { btn.disabled = false; });
}
function deleteFolder(id){
  const f = foldersById.get(id); if(!f) return;
  const pm = linkedProjectMaster(f);
  if(pm){ toast(`"${f.name}" is the folder for project "${pm.name}". Delete the project in Masters → Project Master first — the folder (and its files) is then kept as an ordinary folder.`, 'err'); return; }
  if(childFolders(id).length){ toast('This folder has subfolders — delete or move them first.', 'err'); return; }
  db.collection('documents').where('folderId', '==', id).limit(1).get().then(s => {
    if(!s.empty){ toast('This folder still has files — move them out first (Configurations → Move File Location).', 'err'); return; }
    if(!confirm(`Are you sure you want to delete this folder?\n\n"${folderPath(id)}"`)) return;
    return db.collection('folders').doc(id).delete().then(() => {
      toast('Folder deleted.', 'ok');
      if(fmActiveFolderId === id) openFmDashboard({ history: 'replace' });
    });
  }).catch(err => toast('Could not delete: ' + err.message, 'err'));
}

/* ============================================================
   FOLDER PROPERTIES (name, description, reviewers, approvers)
============================================================ */
function populateUserDualListbox(availId, selId, selectedUids){
  const sel = new Set(selectedUids || []);
  const label = u => `${u.name}${u.department ? ' (' + u.department + ')' : ''}`;
  const active = usersData.filter(u => u.enabled !== false);
  document.getElementById(availId).innerHTML = active.filter(u => !sel.has(u.id)).map(u => `<option value="${u.id}">${escapeHtml(label(u))}</option>`).join('');
  document.getElementById(selId).innerHTML = [...sel].map(uid => {
    const u = usersData.find(x => x.id === uid);
    return `<option value="${uid}">${escapeHtml(u ? label(u) : 'Unknown user')}</option>`;
  }).join('');
}
function openFolderPropsModal(id){
  const f = foldersById.get(id); if(!f) return;
  fmPropsFolderId = id;
  document.getElementById('fpPath').textContent = folderPath(id);
  document.getElementById('fpFolderNo').textContent = fmtFolderNo(f.folderNo);
  document.getElementById('fpCreated').textContent = `${f.createdByName || '—'} · ${fmtDay(f.createdAt)}`;
  document.getElementById('fpName').value = f.name;
  const pm = linkedProjectMaster(f);
  document.getElementById('fpName').disabled = !!pm;
  document.getElementById('fpNameNote').textContent = pm ? 'Project folder — its name follows the project in Masters → Project Master.' : '';
  document.getElementById('fpDescription').value = f.description || '';
  populateUserDualListbox('fpRevAvail', 'fpRevSel', f.reviewers || []);
  populateUserDualListbox('fpAppAvail', 'fpAppSel', f.approvers || []);
  const parentSrc = f.parentId ? folderWorkflowSource(f.parentId) : null;
  document.getElementById('fpInheritNote').innerHTML = parentSrc
    ? `If you leave both lists empty, this folder inherits <b>${(parentSrc.reviewers || []).length} reviewer(s) &rarr; ${(parentSrc.approvers || []).length} approver(s)</b> from <b>${escapeHtml(folderPath(parentSrc.id))}</b>.`
    : 'If you leave both lists empty, uploads here use the <b>Document Category workflow</b> from Configurations &rarr; Workflow Configuration.';
  openModal('folderPropsModalOverlay');
}
function submitFolderProps(){
  const id = fmPropsFolderId; const f = foldersById.get(id); if(!f) return;
  const name = linkedProjectMaster(f) ? f.name : document.getElementById('fpName').value.trim();
  const issue = folderNameIssue(name, f.parentId || null, id);
  if(issue){ toast(issue, 'err'); return; }
  const vals = sid => Array.from(document.getElementById(sid).options).map(o => o.value);
  db.collection('folders').doc(id).update({
    name, description: document.getElementById('fpDescription').value.trim(),
    reviewers: vals('fpRevSel'), approvers: vals('fpAppSel'),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => { toast('Folder properties saved. New uploads here will use this workflow.', 'ok'); closeModal('folderPropsModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}

/* ============================================================
   FOLDER PERMISSIONS (User / Role / Department)
============================================================ */
const PERM_KEYS = { user: 'users', role: 'roles', department: 'departments' };
function permEntityOptions(kind){
  if(kind === 'user') return usersData.filter(u => u.enabled !== false).map(u => ({ id: u.id, label: `${u.name}${u.department ? ' (' + u.department + ')' : ''}` }));
  if(kind === 'role') return Object.entries(ROLE_LABELS).filter(([id]) => id !== 'admin').map(([id, name]) => ({ id, label: name }));
  return mastersData.departmentMasters.filter(d => !d.parentId).map(d => ({ id: d.name, label: d.name }));
}
function openFolderPermModal(id){
  const f = foldersById.get(id); if(!f) return;
  const p = f.permissions || {};
  permFolderId = id;
  permDraft = { users: [...(p.users || [])], roles: [...(p.roles || [])], departments: [...(p.departments || [])] };
  permEntity = 'user';
  document.getElementById('fpmEntity').value = 'user';
  document.getElementById('fpmPath').textContent = folderPath(id);
  document.getElementById('fpmApplySub').checked = p.applyToSubfolders !== false;
  renderPermLists();
  openModal('folderPermModalOverlay');
}
function capturePermSelected(){
  permDraft[PERM_KEYS[permEntity]] = Array.from(document.getElementById('fpmSel').options).map(o => o.value);
}
function onPermEntityChange(){
  capturePermSelected();
  permEntity = document.getElementById('fpmEntity').value;
  renderPermLists();
}
function renderPermLists(){
  const opts = permEntityOptions(permEntity);
  const sel = new Set(permDraft[PERM_KEYS[permEntity]]);
  document.getElementById('fpmAvail').innerHTML = opts.filter(o => !sel.has(o.id)).map(o => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`).join('');
  document.getElementById('fpmSel').innerHTML = [...sel].map(idv => {
    const o = opts.find(x => x.id === idv);
    return `<option value="${escapeHtml(idv)}">${escapeHtml(o ? o.label : idv)}</option>`;
  }).join('');
  const total = permDraft.users.length + permDraft.roles.length + permDraft.departments.length;
  document.getElementById('fpmSummary').innerHTML = `Selected: <b>${permDraft.users.length}</b> user(s), <b>${permDraft.roles.length}</b> role(s), <b>${permDraft.departments.length}</b> department(s)` +
    (total === 0 ? ' &mdash; <span style="color:var(--teal);">nothing selected, so this folder stays open to all users (unless a parent folder restricts it)</span>' : '');
}
function movePermEntities(dir){
  if(dir === 'add') moveDualListbox('fpmAvail', 'fpmSel'); else moveDualListbox('fpmSel', 'fpmAvail');
  capturePermSelected();
  renderPermLists();
}
function submitFolderPerm(){
  capturePermSelected();
  const id = permFolderId;
  db.collection('folders').doc(id).update({
    permissions: { ...permDraft, applyToSubfolders: document.getElementById('fpmApplySub').checked },
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => { toast('Permissions saved.', 'ok'); closeModal('folderPermModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}

/* ============================================================
   SELECTS shared by Upload / Move / Reports / search
============================================================ */
function fillFolderSelect(selId, items, placeholder){
  const sel = document.getElementById(selId);
  if(!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>` + items.map(o => `<option value="${o.id}">${escapeHtml(o.path)}</option>`).join('');
  if(prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}
function populateFolderSelects(){
  if(!currentUser) return;
  const accessible = folderOptions(true);
  const all = folderOptions(false);
  fillFolderSelect('fFolder', accessible, 'Select folder&hellip;');
  fillFolderSelect('mfDest', all, 'Select destination folder&hellip;');
  fillFolderSelect('mfSource', [{ id: UNFILED, path: '(Unfiled — uploaded before folders)' }, ...all], 'Select source folder&hellip;');
  fillFolderSelect('filterFolder', [{ id: UNFILED, path: '(Unfiled — uploaded before folders)' }, ...accessible], 'All folders');
  fillFolderSelect('rfFolder', [{ id: UNFILED, path: '(Unfiled)' }, ...all], 'All folders');
}

/* ============================================================
   ROOT FOLDER (admin)
============================================================ */
function renderRootFolderView(){
  const body = document.getElementById('rootFolderTableBody');
  if(!body || !currentUser) return;
  const roots = childFolders(null);
  if(!foldersLoaded){ body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>Loading&hellip;</b></div></td></tr>`; return; }
  const others = roots.filter(f => !linkedProjectMaster(f));
  const note = document.getElementById('rootNonProjectNote');
  if(note){
    note.classList.toggle('hidden', !others.length);
    note.innerHTML = others.length ? `<b>${others.length} root folder${others.length === 1 ? ' is' : 's are'} not a project:</b> ${others.map(f => escapeHtml(f.name)).join(', ')}.
      <div style="margin-top:6px; font-size:13px;">Only project folders should be at the top. For each one, use <b>&#10142; Move into project</b> to put it inside a project folder, or delete it once it's empty. Nothing is moved or deleted automatically, so no files are lost.</div>` : '';
  }
  if(roots.length === 0){ body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="ic">&#128193;</div><b>No root folders yet</b><div>Add your projects in Masters &rarr; Project Master; each one gets its root folder automatically.</div></div></td></tr>`; return; }
  roots.sort((a, b) => (linkedProjectMaster(a) ? 0 : 1) - (linkedProjectMaster(b) ? 0 : 1) || a.name.localeCompare(b.name));
  body.innerHTML = roots.map(f => `<tr>
    <td><span class="drawing-code">${fmtFolderNo(f.folderNo)}</span></td>
    <td><span style="display:inline-flex; align-items:center; gap:8px;">${FOLDER_SVG}${escapeHtml(f.name)}${linkedProjectMaster(f) ? ' <span class="fm-tag project">Project</span>' : ' <span class="fm-tag restricted">Not a project</span>'}</span></td>
    <td>${descendantIds(f.id).length}</td>
    <td><span class="fm-tag ${isFolderRestricted(f.id) ? 'restricted' : 'open'}">${isFolderRestricted(f.id) ? 'Restricted' : 'Open'}</span></td>
    <td>${escapeHtml(f.createdByName || '—')}</td>
    <td style="text-align:right; white-space:nowrap;">
      <button class="icon-btn-sm" onclick="openFmFolder('${f.id}')" title="Open">&#128194;</button>
      ${linkedProjectMaster(f) ? '' : `<button class="btn btn-outline-orange btn-sm" onclick="openMoveRootModal('${f.id}')">&#10142; Move into project</button>
      <button class="icon-btn-sm" onclick="openRenameFolderModal('${f.id}')" title="Rename">&#9999;&#65039;</button>
      <button class="icon-btn-sm" onclick="deleteFolder('${f.id}')" title="Delete">&#128465;&#65039;</button>`}
    </td></tr>`).join('');
}
// Put a hand-made (non-project) root folder inside a project folder.
let mrFolderId = null;
function openMoveRootModal(id){
  const f = foldersById.get(id); if(!f || linkedProjectMaster(f)) return;
  const targets = childFolders(null).filter(x => linkedProjectMaster(x)).sort((a, b) => a.name.localeCompare(b.name));
  if(!targets.length){ toast('There are no project folders yet. Add a project in Masters → Project Master first.', 'err'); return; }
  mrFolderId = id;
  document.getElementById('mrInfo').innerHTML = `Folder: <b>${escapeHtml(f.name)}</b> &middot; ${descendantIds(id).length} subfolder(s)`;
  document.getElementById('mrTarget').innerHTML = targets.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  openModal('moveRootModalOverlay');
}
function submitMoveRoot(){
  const f = foldersById.get(mrFolderId); if(!f) return;
  const targetId = document.getElementById('mrTarget').value;
  if(!targetId) return;
  const clash = folderNameIssue(f.name, targetId, f.id);
  if(clash){ toast(`${foldersById.get(targetId).name} already has a folder called "${f.name}". Rename one of them first.`, 'err'); return; }
  const btn = document.getElementById('mrConfirmBtn'); btn.disabled = true;
  db.collection('folders').doc(f.id).update({ parentId: targetId, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => { fmExpanded.add(targetId); toast(`Moved: ${folderPath(f.id)}`, 'ok'); closeModal('moveRootModalOverlay'); })
    .catch(err => toast('Could not move: ' + err.message, 'err'))
    .finally(() => { btn.disabled = false; });
}

/* ============================================================
   SET PARAMETER (admin)
============================================================ */
function fillSetParamForm(){
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.value = v; };
  set('spAllowedExt', dmsParams.allowedExtensions);
  set('spMaxSize', dmsParams.maxFileSizeMB);
  set('spReviewTat', dmsParams.reviewTatDays);
  set('spApprovalTat', dmsParams.approvalTatDays);
  set('spFolderDigits', dmsParams.folderNoDigits);
  const sg = document.getElementById('spSigSheet'); if(sg) sg.checked = dmsParams.signatureSheet !== false;
}
function saveDmsParams(ev){
  if(ev) ev.preventDefault();
  const num = (id, min, max) => { const v = Number(document.getElementById(id).value); return isFinite(v) ? Math.min(max, Math.max(min, v)) : null; };
  const data = {
    allowedExtensions: document.getElementById('spAllowedExt').value.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean).join(','),
    maxFileSizeMB: num('spMaxSize', 0, 2048), reviewTatDays: num('spReviewTat', 0, 365),
    approvalTatDays: num('spApprovalTat', 0, 365), folderNoDigits: num('spFolderDigits', 1, 12)
  };
  if(Object.values(data).some(v => v === null)){ toast('Please enter valid numbers.', 'err'); return false; }
  const sg = document.getElementById('spSigSheet'); if(sg) data.signatureSheet = sg.checked;
  db.collection('dmsSettings').doc('params').set(data, { merge: true })
    .then(() => toast('Parameters saved.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
  return false;
}

/* ============================================================
   EMAIL CONFIGURATION (admin)
============================================================ */
function fillEmailConfigForm(){
  const el = id => document.getElementById(id);
  if(!el('ecEnabled')) return;
  el('ecEnabled').checked = !!emailConfig.enabled;
  el('ecFromName').value = emailConfig.fromName || '';
  el('ecFromAddress').value = emailConfig.fromAddress || '';
  el('ecReplyTo').value = emailConfig.replyTo || '';
  el('ecAppUrl').value = emailConfig.appUrl || '';
  el('ecOnTask').checked = emailConfig.onTaskAssigned !== false;
  el('ecOnRejected').checked = emailConfig.onRejected !== false;
  el('ecOnPublished').checked = emailConfig.onPublished !== false;
  el('ecOnSubscribed').checked = emailConfig.onSubscribedUpload !== false;
}
function saveEmailConfig(ev){
  if(ev) ev.preventDefault();
  const el = id => document.getElementById(id);
  const data = {
    enabled: el('ecEnabled').checked, fromName: el('ecFromName').value.trim(), fromAddress: el('ecFromAddress').value.trim(),
    replyTo: el('ecReplyTo').value.trim(), appUrl: el('ecAppUrl').value.trim(),
    onTaskAssigned: el('ecOnTask').checked, onRejected: el('ecOnRejected').checked,
    onPublished: el('ecOnPublished').checked, onSubscribedUpload: el('ecOnSubscribed').checked
  };
  db.collection('dmsSettings').doc('email').set(data, { merge: true })
    .then(() => toast('Email configuration saved.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
  return false;
}
function sendTestEmail(){
  if(!currentUser.email){ toast('Your account has no email address.', 'err'); return; }
  sendMailDoc([currentUser.email], 'MP DMS — test email', 'This is a test email from MP DMS Email Configuration. If you received it, email delivery is working.', { kind: 'test' })
    .then(() => toast(`Test email queued for ${currentUser.email}. If it doesn't arrive in a minute, check the Trigger Email extension's logs.`, 'ok'));
}

/* ============================================================
   REPORTS
============================================================ */
function openReport(which){
  fmActiveReport = which; fmReportRows = null;
  document.querySelectorAll('.report-row').forEach(r => r.classList.toggle('active', r.dataset.report === which));
  const panel = document.getElementById('reportPanel');
  if(which === 'files'){
    panel.innerHTML = `
      <div class="card panel" style="margin-bottom:14px;">
        <h3 style="margin-bottom:12px;">Files Details</h3>
        <div class="doc-filter-row">
          <div class="field" style="margin-bottom:0; min-width:260px;"><label>Folder</label><select id="rfFolder"></select></div>
          <div class="field" style="margin-bottom:0; min-width:auto;"><label>&nbsp;</label><label style="display:flex; align-items:center; gap:6px; font-weight:500; color:var(--text);"><input type="checkbox" id="rfIncludeSub" checked style="width:auto;"> Include subfolders</label></div>
          <div class="field" style="margin-bottom:0;"><label>Status</label><select id="rfStatus"><option value="">All statuses</option>${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select></div>
          <div class="field" style="margin-bottom:0; min-width:140px;"><label>Uploaded From</label><input type="date" id="rfFrom"></div>
          <div class="field" style="margin-bottom:0; min-width:140px;"><label>Uploaded To</label><input type="date" id="rfTo"></div>
          <button class="btn btn-orange btn-sm" style="align-self:flex-end;" onclick="runFilesDetailsReport()">Run Report</button>
          <button class="btn btn-ghost btn-sm" style="align-self:flex-end;" id="rfExportBtn" onclick="exportCurrentReport()" disabled>Export CSV</button>
        </div>
      </div>
      <div class="card" id="reportResult"><div class="fm-empty-note" style="padding:20px;">Choose filters and click Run Report.</div></div>`;
    populateFolderSelects();
  } else {
    panel.innerHTML = `
      <div class="card panel" style="margin-bottom:14px; display:flex; align-items:center; justify-content:space-between;">
        <h3>Folder Approver Details</h3>
        <button class="btn btn-ghost btn-sm" id="rfExportBtn" onclick="exportCurrentReport()">Export CSV</button>
      </div>
      <div class="card" id="reportResult"></div>`;
    runFolderApproverReport();
  }
}
function runFilesDetailsReport(){
  const crit = {
    folderId: document.getElementById('rfFolder').value,
    includeSub: document.getElementById('rfIncludeSub').checked,
    status: document.getElementById('rfStatus').value,
    from: document.getElementById('rfFrom').value, to: document.getElementById('rfTo').value
  };
  const out = document.getElementById('reportResult');
  out.innerHTML = '<div class="fm-empty-note" style="padding:20px;">Running&hellip;</div>';
  fetchAllDocuments().then(docs => {
    const rows = docs.filter(d => canAccessDoc(d) && docMatchesCrit(d, crit))
      .sort((a, b) => folderPath(a.folderId).localeCompare(folderPath(b.folderId)) || String(a.drawingNumber).localeCompare(String(b.drawingNumber)));
    fmReportRows = {
      filename: 'files-details.csv',
      headers: ['Folder', 'Drawing No.', 'Title', 'File Name', 'Version', 'Revision', 'Status', 'Project', 'Department', 'Category', 'Uploaded By', 'Uploaded On', 'Last Updated'],
      rows: rows.map(d => [folderPath(d.folderId), d.drawingNumber, d.title, d.currentFileName || '', 'v' + (d.currentVersionNo || 1), d.currentRevision || '',
        STATUS_LABELS[d.status] || d.status, d.project, d.department, d.category, d.createdByName, fmtDay(d.createdAt), fmtDay(d.updatedAt)])
    };
    document.getElementById('rfExportBtn').disabled = rows.length === 0;
    out.innerHTML = rows.length === 0 ? '<div class="fm-empty-note" style="padding:20px;">No files match these filters.</div>' :
      `<div class="fm-report-count">${rows.length} file(s)</div><div style="overflow-x:auto;"><table class="fm-table"><thead><tr>${fmReportRows.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((d, i) => `<tr onclick="openDocumentDetail('${d.id}')">${fmReportRows.rows[i].map((c, j) => `<td${j === 0 ? ' class="fm-file-cell"' : ''}>${escapeHtml(c == null ? '—' : c)}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;
  }).catch(err => { out.innerHTML = `<div class="fm-empty-note" style="padding:20px;">Could not run report: ${escapeHtml(err.message)}</div>`; });
}
function describePerms(p){
  if(permCount(p) === 0) return 'Open';
  const parts = [];
  if((p.users || []).length) parts.push('Users: ' + p.users.map(userName).join(', '));
  if((p.roles || []).length) parts.push('Roles: ' + p.roles.map(r => ROLE_LABELS[r] || r).join(', '));
  if((p.departments || []).length) parts.push('Depts: ' + p.departments.join(', '));
  return parts.join(' · ');
}
function runFolderApproverReport(){
  const out = document.getElementById('reportResult');
  if(!out) return;
  const list = folderOptions(false).map(o => foldersById.get(o.id));
  const rows = list.map(f => {
    const src = folderWorkflowSource(f.id);
    const own = src && src.id === f.id;
    return [fmtFolderNo(f.folderNo), folderPath(f.id),
      src ? (src.reviewers || []).map(userName).join(', ') : '', src ? (src.approvers || []).map(userName).join(', ') : '',
      src ? (own ? 'Own' : 'Inherited from ' + folderPath(src.id)) : 'Document Category workflow',
      describePerms(f.permissions), permCount(f.permissions) ? (f.permissions.applyToSubfolders !== false ? 'Yes' : 'No') : '—',
      (f.subscribers || []).length];
  });
  fmReportRows = { filename: 'folder-approver-details.csv', headers: ['Folder No.', 'Folder', 'Reviewers', 'Approvers', 'Workflow Source', 'Permissions', 'Applies to Subfolders', 'Subscribers'], rows };
  out.innerHTML = rows.length === 0 ? '<div class="fm-empty-note" style="padding:20px;">No folders yet.</div>' :
    `<div class="fm-report-count">${rows.length} folder(s)</div><div style="overflow-x:auto;"><table class="fm-table"><thead><tr>${fmReportRows.headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>
      ${rows.map((r, i) => `<tr onclick="openFmFolder('${list[i].id}')">${r.map(c => `<td>${escapeHtml(c === '' ? '—' : c)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}
function exportCurrentReport(){
  if(!fmReportRows || !fmReportRows.rows.length){ toast('Run the report first.', 'err'); return; }
  downloadCsv(fmReportRows.filename, fmReportRows.headers, fmReportRows.rows);
}

/* ============================================================
   ALERTS — overdue reviews / approvals
============================================================ */
function renderAlerts(){
  const panel = document.getElementById('alertsPanel');
  if(!panel || !currentUser) return;
  const me = currentUser.uid;
  const all = [...queueMap.values()].filter(v => {
    if(!isOverdue(v)) return false;
    if(fmIsAdmin()) return true;
    return v.uploadedBy === me || stepIsMine(v);
  }).sort((a, b) => stageStartMs(a) - stageStartMs(b));
  const reviews = all.filter(v => v.status === 'pending_review').length;
  const approvals = all.filter(v => v.status === 'pending_approval').length;
  const mineCount = all.filter(stepIsMine).length;
  const assignees = v => (v.steps || []).filter(s => s.stage === v.currentStage && s.decision === 'pending')
    .map(s => s.uid ? userName(s.uid) : (ROLE_LABELS[s.role] || s.role)).join(', ');
  panel.innerHTML = `
    <div class="stat-row">
      <div class="stat-card accent-red"><div class="num">${all.length}</div><div class="lbl">Overdue items${fmIsAdmin() ? ' (all users)' : ''}</div></div>
      <div class="stat-card accent-gold"><div class="num">${reviews}</div><div class="lbl">Overdue reviews (TAT ${Number(dmsParams.reviewTatDays)} d)</div></div>
      <div class="stat-card accent-gold"><div class="num">${approvals}</div><div class="lbl">Overdue approvals (TAT ${Number(dmsParams.approvalTatDays)} d)</div></div>
      <div class="stat-card accent-teal"><div class="num">${mineCount}</div><div class="lbl">Waiting on me</div></div>
    </div>
    <div class="card">
      ${all.length === 0 ? `<div class="empty-state"><div class="ic">&#9989;</div><b>No overdue files</b><div>Alerts lists files that have been waiting <b>longer than the TAT</b> &mdash; Review ${Number(dmsParams.reviewTatDays)} day(s), Approval ${Number(dmsParams.approvalTatDays)} day(s) (Configurations &rarr; Set Parameter).<br>Right now <b>${queueMap.size}</b> file(s) are in review/approval and none of them is overdue.</div></div>` :
      `<table class="fm-table"><thead><tr><th>Drawing No.</th><th>Title</th><th>Folder</th><th>Stage</th><th>Waiting On</th><th>Days</th><th></th></tr></thead><tbody>
        ${all.map(v => {
          const days = Math.floor((Date.now() - stageStartMs(v)) / 86400000);
          const canRemind = fmIsAdmin() || v.uploadedBy === me;
          return `<tr onclick="openDocumentDetail('${v.docId}')">
            <td><span class="drawing-code">${escapeHtml(v.docDrawingNumber || '—')}</span></td>
            <td>${escapeHtml(v.docTitle || '—')}</td>
            <td>${escapeHtml(v.docFolderId ? folderPath(v.docFolderId) : '—')}</td>
            <td><span class="badge st-${v.status}"><span class="dot"></span>${escapeHtml(STATUS_LABELS[v.status] || v.status)}</span></td>
            <td>${escapeHtml(assignees(v) || '—')}</td>
            <td><span class="overdue-tag">${days}</span></td>
            <td style="text-align:right;">${canRemind ? `<button class="btn btn-outline-orange btn-sm" onclick="event.stopPropagation(); remindPending('${v.docId}','${v.id}')">Send reminder</button>` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table>`}
    </div>`;
}
function remindPending(docId, versionId){
  const v = queueMap.get(versionId); if(!v) return;
  const pending = (v.steps || []).filter(s => s.stage === v.currentStage && s.decision === 'pending');
  const days = Math.floor((Date.now() - stageStartMs(v)) / 86400000);
  notifyTask(pending, `Reminder: ${v.docDrawingNumber} — ${v.docTitle} has been waiting ${days} day(s) for your action.`, docId);
  toast('Reminder sent.', 'ok');
}

/* ============================================================
   MOVE FILE LOCATION (admin)
============================================================ */
function loadMoveCandidates(){
  const src = document.getElementById('mfSource').value;
  const from = document.getElementById('mfFrom').value;
  const to = document.getElementById('mfTo').value;
  const totalEl = document.getElementById('mfTotal');
  if(!src || !from || !to){ fmMoveCandidates = []; totalEl.textContent = '0'; return Promise.resolve([]); }
  totalEl.textContent = '…';
  const q = src === UNFILED
    ? fetchAllDocuments().then(ds => ds.filter(d => !d.folderId))
    : db.collection('documents').where('folderId', '==', src).get().then(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
  return q.then(ds => {
    const fromMs = new Date(from + 'T00:00:00').getTime(), toMs = new Date(to + 'T23:59:59').getTime();
    fmMoveCandidates = ds.filter(d => { const ms = tsMs(d.createdAt); return ms >= fromMs && ms <= toMs; });
    totalEl.textContent = String(fmMoveCandidates.length);
    return fmMoveCandidates;
  }).catch(err => { totalEl.textContent = '0'; toast('Could not count files: ' + err.message, 'err'); return []; });
}
function runMoveFiles(){
  const src = document.getElementById('mfSource').value;
  const dest = document.getElementById('mfDest').value;
  const from = document.getElementById('mfFrom').value, to = document.getElementById('mfTo').value;
  if(!from || !to || !src){ toast('From Date, To Date and Files Source Path are required.', 'err'); return; }
  if(from > to){ toast('From Date must be on or before To Date.', 'err'); return; }
  if(!dest){ toast('Please choose a destination folder.', 'err'); return; }
  if(dest === src){ toast('Source and destination are the same folder.', 'err'); return; }
  const btn = document.getElementById('mfGoBtn');
  loadMoveCandidates().then(list => {
    if(!list.length){ toast('No files were uploaded to that folder in this date range.', 'err'); return; }
    const srcPath = src === UNFILED ? '(Unfiled)' : folderPath(src), destPath = folderPath(dest);
    if(!confirm(`Move ${list.length} file(s)\nfrom: ${srcPath}\nto:   ${destPath}\n\nFiles already in review/approval keep their current approvers.`)) return;
    btn.disabled = true; btn.textContent = 'Moving…';
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    const chunks = [];
    for(let i = 0; i < list.length; i += 200) chunks.push(list.slice(i, i + 200));
    return chunks.reduce((p, chunk) => p.then(() => {
      const batch = db.batch();
      chunk.forEach(d => {
        const ref = db.collection('documents').doc(d.id);
        batch.update(ref, { folderId: dest, updatedAt: ts });
        if(d.currentVersionId){
          batch.update(ref.collection('versions').doc(d.currentVersionId), { docFolderId: dest });
          batch.set(ref.collection('versions').doc(d.currentVersionId).collection('history').doc(), {
            action: 'moved', actor: currentUser.uid, actorName: currentUser.name, timestamp: ts,
            remarks: `Moved from ${srcPath} to ${destPath}`, fromStatus: d.status, toStatus: d.status, allocatedTo: ''
          });
        }
      });
      return batch.commit();
    }), Promise.resolve()).then(() => {
      toast(`Moved ${list.length} file(s) to ${destPath}.`, 'ok');
      document.getElementById('mfTotal').textContent = '0';
      fmMoveCandidates = [];
    });
  }).catch(err => toast('Move failed: ' + err.message, 'err'))
    .finally(() => { btn.disabled = false; btn.textContent = 'Go'; });
}

/* ============================================================
   TRANSFER RIGHTS (admin)
============================================================ */
function populateTransferUserSelects(){
  ['trFrom', 'trTo'].forEach(id => {
    const sel = document.getElementById(id); if(!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select employee&hellip;</option>' + usersData.map(u => `<option value="${u.id}">${escapeHtml(u.name)}${u.email ? ' — ' + escapeHtml(u.email) : ''}</option>`).join('');
    if(usersData.some(u => u.id === prev)) sel.value = prev;
  });
}
function pendingTasksFor(uid){
  return [...queueMap.values()].filter(v => (v.steps || []).some(s => s.uid === uid && s.decision === 'pending'));
}
function loadTransferRights(){
  const from = document.getElementById('trFrom').value;
  if(!from){ toast('Please choose an employee.', 'err'); return; }
  fmTransferFrom = from;
  const rows = folderOptions(false).map(o => foldersById.get(o.id)).map(f => {
    const rights = [];
    if(((f.permissions || {}).users || []).includes(from)) rights.push('Permission');
    if((f.reviewers || []).includes(from)) rights.push('Reviewer');
    if((f.approvers || []).includes(from)) rights.push('Approver');
    if((f.subscribers || []).includes(from)) rights.push('Subscriber');
    return { f, rights };
  }).filter(r => r.rights.length);
  const tasks = pendingTasksFor(from);
  const body = document.getElementById('trTableBody');
  body.innerHTML = rows.length
    ? rows.map(r => `<tr>
        <td style="width:40px;"><input type="checkbox" class="tr-cb" value="${r.f.id}" checked style="width:auto;"></td>
        <td>${escapeHtml(folderPath(r.f.id))}</td>
        <td>${r.rights.map(x => `<span class="fm-tag open" style="margin-right:4px;">${x}</span>`).join('')}</td>
      </tr>`).join('')
    : `<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:18px;">No records found &mdash; ${escapeHtml(userName(from))} isn't named personally on any folder (as a Permissions user, Reviewer, Approver or Subscriber).<br>Rights given through a <b>Role</b> or <b>Department</b> don't need transferring: give the new person that role or department in Manage Users.</td></tr>`;
  document.getElementById('trAllCb').checked = true;
  document.getElementById('trTasksNote').innerHTML = tasks.length
    ? `<label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" id="trTasks" checked style="width:auto;"> Also hand over <b>${tasks.length}</b> pending review/approval task(s) assigned to ${escapeHtml(userName(from))}</label>`
    : `<span class="fm-muted">${escapeHtml(userName(from))} has no pending folder-workflow tasks.</span>`;
  document.getElementById('trResult').classList.remove('hidden');
}
function toggleAllTransfer(cb){ document.querySelectorAll('.tr-cb').forEach(x => { x.checked = cb.checked; }); }
function submitTransferRights(){
  const from = fmTransferFrom;
  const to = document.getElementById('trTo').value;
  if(!from){ toast('Choose an employee and click Go first.', 'err'); return; }
  if(!to){ toast('Please choose who to transfer the rights to.', 'err'); return; }
  if(to === from){ toast("Can't transfer rights to the same employee.", 'err'); return; }
  const folderIds = [...document.querySelectorAll('.tr-cb:checked')].map(cb => cb.value);
  const tasksCb = document.getElementById('trTasks');
  const tasks = tasksCb && tasksCb.checked ? pendingTasksFor(from) : [];
  if(!folderIds.length && !tasks.length){ toast('Nothing selected to transfer.', 'err'); return; }
  if(!confirm(`Transfer ${folderIds.length} folder right(s)${tasks.length ? ` and ${tasks.length} pending task(s)` : ''}\nfrom ${userName(from)} to ${userName(to)}?`)) return;
  const swap = arr => [...new Set((arr || []).map(u => u === from ? to : u))];
  const ts = firebase.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  folderIds.forEach(id => {
    const f = foldersById.get(id); if(!f) return;
    batch.update(db.collection('folders').doc(id), {
      'permissions.users': swap((f.permissions || {}).users), reviewers: swap(f.reviewers), approvers: swap(f.approvers),
      subscribers: swap(f.subscribers), updatedAt: ts
    });
  });
  tasks.forEach(v => {
    const steps = v.steps.map(s => (s.uid === from && s.decision === 'pending')
      ? { ...s, uid: to, key: s.key.replace(from, to), label: String(s.label).replace(userName(from), userName(to)) } : s);
    const vRef = db.collection('documents').doc(v.docId).collection('versions').doc(v.id);
    batch.update(vRef, { steps });
    batch.set(vRef.collection('history').doc(), {
      action: 'reassigned', actor: currentUser.uid, actorName: currentUser.name, timestamp: ts,
      remarks: `Pending task reassigned from ${userName(from)} to ${userName(to)} (Transfer Rights)`, fromStatus: v.status, toStatus: v.status, allocatedTo: userName(to)
    });
  });
  batch.commit().then(() => {
    notifyUser(to, `${userName(from)}'s rights on ${folderIds.length} folder(s)${tasks.length ? ` and ${tasks.length} pending task(s)` : ''} were transferred to you.`, null);
    toast('Rights transferred.', 'ok');
    document.getElementById('trResult').classList.add('hidden');
    fmTransferFrom = null;
  }).catch(err => toast('Transfer failed: ' + err.message, 'err'));
}

/* ============================================================
   SIGNATURES
   1. Manage Users -> Edit User: upload each person's signature photo.
      It is cleaned up in the browser (white background removed, trimmed,
      resized) and saved as a PNG at signatures/<uid>/..., with the link
      on users/<uid>.signatureURL.
   2. When a file is published, a SIGNATURE SHEET is added as the FIRST
      page: document details + every person who submitted / reviewed /
      approved it, with name, role, step, date and signature image.
        - PDF            -> sheet inserted as the first page(s)
        - JPG / PNG      -> new PDF: the sheet, then the image
        - anything else  -> no sheet (can't be edited in the browser)
      The signed copy is saved next to the original (signed_<name>.pdf)
      and becomes the file people open; the original is kept.
   Needs the Storage bucket's CORS setting so the browser may read files
   (one-time setup, see README).
============================================================ */
const PDF_LIB_URL = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
let pdfLibPromise = null;
function loadPdfLib(){
  if(window.PDFLib) return Promise.resolve(window.PDFLib);
  if(!pdfLibPromise){
    pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDF_LIB_URL;
      s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('PDF library did not load.'));
      s.onerror = () => { pdfLibPromise = null; reject(new Error('Could not load the PDF library (check the internet connection).')); };
      document.head.appendChild(s);
    });
  }
  return pdfLibPromise;
}

/* ---------- signature upload (Edit User) ---------- */
let sigPendingBlob = null;
function renderEditUserSignature(u){
  sigPendingBlob = null;
  const prev = document.getElementById('editUserSigPreview');
  const note = document.getElementById('editUserSigNote');
  document.getElementById('editUserSigFile').value = '';
  if(u && u.signatureURL){
    prev.innerHTML = `<img src="${escapeHtml(u.signatureURL)}" alt="Signature">`;
    note.textContent = u.signatureUpdatedAt ? 'Uploaded ' + fmtDay(u.signatureUpdatedAt) : '';
    document.getElementById('editUserSigRemoveBtn').classList.remove('hidden');
  } else {
    prev.innerHTML = '<span class="fm-muted">No signature uploaded</span>';
    note.textContent = '';
    document.getElementById('editUserSigRemoveBtn').classList.add('hidden');
  }
  document.getElementById('editUserSigSaveBtn').classList.add('hidden');
}
// Turn a photo/scan of a signature into a clean transparent PNG.
// Works on grey or shadowed photos: the paper's brightness is measured in
// small areas across the photo, so each pixel is compared with the paper
// around it rather than with pure white.
function processSignatureImage(file, removeBg){
  return new Promise((resolve, reject) => {
    if(!/^image\/(png|jpe?g|webp)$/i.test(file.type)){ reject(new Error('Please choose a PNG or JPG image.')); return; }
    if(file.size > 15 * 1024 * 1024){ reject(new Error('Image is too large (max 15 MB).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1200 / img.width, 600 / img.height);
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // transparent PNGs: treat empty as paper
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      URL.revokeObjectURL(url);
      const L = new Float32Array(w * h);
      for(let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

      if(removeBg){
        // 1. paper brightness per block = a bright percentile of the block
        const B = Math.max(12, Math.round(Math.min(w, h) / 10));
        const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
        const blk = new Float32Array(bw * bh);
        for(let by = 0; by < bh; by++) for(let bx = 0; bx < bw; bx++){
          const vals = [];
          for(let y = by * B; y < Math.min(h, (by + 1) * B); y += 2) for(let x = bx * B; x < Math.min(w, (bx + 1) * B); x += 2) vals.push(L[y * w + x]);
          vals.sort((a, b) => a - b);
          blk[by * bw + bx] = vals[Math.floor(vals.length * 0.9)] || 255;
        }
        // 2. take the brightest neighbouring block, so thick strokes don't count as paper
        const bg = new Float32Array(bw * bh);
        for(let by = 0; by < bh; by++) for(let bx = 0; bx < bw; bx++){
          let m = 0;
          for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){
            const yy = by + dy, xx = bx + dx;
            if(yy >= 0 && yy < bh && xx >= 0 && xx < bw) m = Math.max(m, blk[yy * bw + xx]);
          }
          bg[by * bw + bx] = Math.max(m, 40);
        }
        // 3. compare every pixel with the (smoothly interpolated) paper around it
        const dark = new Float32Array(w * h);
        for(let y = 0; y < h; y++){
          const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)); const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
          for(let x = 0; x < w; x++){
            const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)); const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
            const paper = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
            const j = y * w + x, i = j * 4;
            dark[j] = 1 - Math.min(1, L[j] / paper);                  // 0 = paper, 1 = black
          }
        }
        // 4. keep faint marks only next to clearly dark strokes (drops shadows and paper texture)
        const strong = new Uint8Array(w * h);
        for(let j = 0; j < strong.length; j++) strong[j] = dark[j] > 0.24 ? 1 : 0;
        const R = 3, tmp = new Uint8Array(w * h), near = new Uint8Array(w * h);
        for(let y = 0; y < h; y++){ let run = -1e9; for(let x = 0; x < w; x++){ if(strong[y * w + x]) run = x; tmp[y * w + x] = x - run <= R ? 1 : 0; }
          run = 1e9; for(let x = w - 1; x >= 0; x--){ if(strong[y * w + x]) run = x; if(run - x <= R) tmp[y * w + x] = 1; } }
        for(let x = 0; x < w; x++){ let run = -1e9; for(let y = 0; y < h; y++){ if(tmp[y * w + x]) run = y; near[y * w + x] = y - run <= R ? 1 : 0; }
          run = 1e9; for(let y = h - 1; y >= 0; y--){ if(tmp[y * w + x]) run = y; if(run - y <= R) near[y * w + x] = 1; } }
        for(let j = 0, i = 0; j < dark.length; j++, i += 4){
          const a = near[j] ? Math.max(0, Math.min(1, (dark[j] - 0.09) / 0.2)) : 0;
          px[i] = px[i] * 0.55; px[i + 1] = px[i + 1] * 0.55; px[i + 2] = px[i + 2] * 0.55; // deepen the ink, keep its colour
          px[i + 3] = Math.round(255 * a);
        }
      }
      // trim to the signature
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
        const i = (y * w + x) * 4;
        const ink = removeBg ? px[i + 3] > 60 : L[y * w + x] < 200;
        if(ink){ if(x < minX) minX = x; if(x > maxX) maxX = x; if(y < minY) minY = y; if(y > maxY) maxY = y; }
      }
      ctx.putImageData(data, 0, 0);
      if(maxX < 0){ reject(new Error('No signature found in the image — try a darker pen, or untick "Remove white background".')); return; }
      const pad = 8;
      const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
      const cw = Math.min(w - cx, maxX - minX + 1 + pad * 2), ch = Math.min(h - cy, maxY - minY + 1 + pad * 2);
      const outScale = Math.min(1, 900 / cw, 320 / ch);
      const out = document.createElement('canvas'); out.width = Math.round(cw * outScale); out.height = Math.round(ch * outScale);
      out.getContext('2d').drawImage(c, cx, cy, cw, ch, 0, 0, out.width, out.height);
      out.toBlob(b => b ? resolve(b) : reject(new Error('Could not process the image.')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}
function onSignatureFileChosen(){
  const f = document.getElementById('editUserSigFile').files[0];
  if(!f) return;
  const removeBg = document.getElementById('editUserSigCleanBg').checked;
  processSignatureImage(f, removeBg).then(blob => {
    sigPendingBlob = blob;
    const url = URL.createObjectURL(blob);
    document.getElementById('editUserSigPreview').innerHTML = `<img src="${url}" alt="New signature">`;
    document.getElementById('editUserSigNote').textContent = 'Preview — click "Save signature" to keep it.';
    document.getElementById('editUserSigSaveBtn').classList.remove('hidden');
  }).catch(err => { toast(err.message, 'err'); document.getElementById('editUserSigFile').value = ''; });
}
function saveUserSignature(){
  const uid = editingUserId;
  if(!uid || !sigPendingBlob) return;
  const btn = document.getElementById('editUserSigSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const old = usersData.find(u => u.id === uid);
  const path = `signatures/${uid}/signature_${Date.now()}.png`;
  const ref = storage.ref(path);
  ref.put(sigPendingBlob, { contentType: 'image/png' })
    .then(() => ref.getDownloadURL())
    .then(url => db.collection('users').doc(uid).update({
      signatureURL: url, signaturePath: path, signatureUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }))
    .then(() => {
      if(old && old.signaturePath && old.signaturePath !== path) storage.ref(old.signaturePath).delete().catch(() => {});
      sigPendingBlob = null;
      toast('Signature saved. It will appear on the signature sheet of files this person approves.', 'ok');
      btn.classList.add('hidden');
      document.getElementById('editUserSigNote').textContent = 'Saved';
      document.getElementById('editUserSigRemoveBtn').classList.remove('hidden');
    })
    .catch(err => toast('Could not save the signature: ' + err.message, 'err'))
    .finally(() => { btn.disabled = false; btn.textContent = 'Save signature'; });
}
function removeUserSignature(){
  const uid = editingUserId;
  const u = usersData.find(x => x.id === uid);
  if(!u || !u.signatureURL) return;
  if(!confirm(`Remove ${u.name}'s signature?`)) return;
  db.collection('users').doc(uid).update({ signatureURL: null, signaturePath: null, signatureUpdatedAt: null })
    .then(() => {
      if(u.signaturePath) storage.ref(u.signaturePath).delete().catch(() => {});
      toast('Signature removed.', 'ok');
      renderEditUserSignature({});
    })
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}

/* ---------- signature sheet on publish ---------- */
function fileKind(name){
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if(ext === 'pdf') return 'pdf';
  if(ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if(ext === 'png') return 'png';
  return null;
}
function fetchBytes(url){
  return fetch(url).then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
    .catch(err => {
      throw new Error(/Failed to fetch|NetworkError|Load failed/i.test(err.message)
        ? "The browser wasn't allowed to read the file from Firebase Storage. The Storage bucket's CORS setting needs to be done once (see README → Signatures)."
        : err.message);
    });
}
function fileBytes(path, url){
  return (path ? storage.ref(path).getDownloadURL() : Promise.resolve(url)).then(fetchBytes);
}
// Who goes on the sheet: the uploader, then every approved step in order.
function signatureRows(v){
  const rows = [];
  const uploader = usersData.find(u => u.id === v.uploadedBy);
  rows.push({ uid: v.uploadedBy, name: v.uploadedByName || (uploader && uploader.name) || '—', action: 'Prepared / Submitted', step: 'Upload', at: tsMs(v.uploadedAt) });
  (v.steps || []).filter(s => s.decision === 'approved').sort((a, b) => a.stage - b.stage || tsMs(a.decidedAt) - tsMs(b.decidedAt)).forEach(s => {
    const isFinal = s.stage === Math.max(...v.steps.map(x => x.stage));
    const label = String(s.label || '').replace(/\s+—\s+.*$/, '');
    rows.push({ uid: s.decidedBy, name: s.decidedByName || userName(s.decidedBy), action: isFinal ? 'Approved & Published' : (String(s.key).startsWith('rv_') ? 'Reviewed' : 'Approved'), step: label, at: tsMs(s.decidedAt) });
  });
  return rows.map(r => {
    const u = usersData.find(x => x.id === r.uid);
    return { ...r, role: u ? (ROLE_LABELS[u.role] || u.role || '') : '', signatureURL: u ? u.signatureURL : null, signaturePath: u ? u.signaturePath : null };
  });
}
function fmtStamp(ms){
  if(!ms) return '—';
  return new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function buildSignedPdf(PDFLib, v, docData, srcBytes, kind, rows){
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  let pdf;
  if(kind === 'pdf'){
    pdf = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  } else {
    pdf = await PDFDocument.create();
    const img = kind === 'png' ? await pdf.embedPng(srcBytes) : await pdf.embedJpg(srcBytes);
    const maxW = 842, maxH = 1191; // fit within A3 portrait/landscape
    const landscape = img.width > img.height;
    const pw = landscape ? maxH : maxW, ph = landscape ? maxW : maxH;
    const sc = Math.min((pw - 40) / img.width, (ph - 40) / img.height, 1);
    const page = pdf.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - img.width * sc) / 2, y: (ph - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const safe = s => Array.from(String(s == null ? '' : s)).map(ch => charset.has(ch.codePointAt(0)) ? ch : '?').join('');
  const fit = (s, f, size, maxW) => { s = safe(s); if(f.widthOfTextAtSize(s, size) <= maxW) return s; while(s.length > 1 && f.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1); return s + '…'; };
  const navy = rgb(0.106, 0.227, 0.420), orange = rgb(0.953, 0.439, 0.129), grey = rgb(0.42, 0.45, 0.5), line = rgb(0.82, 0.85, 0.89), text = rgb(0.12, 0.14, 0.18);

  // signature images
  const sigImgs = await Promise.all(rows.map(r => !r.signatureURL ? null :
    fileBytes(r.signaturePath, r.signatureURL).then(b => pdf.embedPng(b)).catch(() => null)));

  const W = 595.28, H = 841.89, M = 40;                       // A4 portrait
  const cols = [ { t: '#', w: 22 }, { t: 'Name & Role', w: 140 }, { t: 'Action / Step', w: 108 }, { t: 'Date & Time', w: 108 }, { t: 'Signature', w: W - 2 * M - 378 } ];
  const rowH = 62;
  const sheetPages = [];
  let page, y;
  const newPage = first => {
    page = pdf.insertPage(sheetPages.length, [W, H]); sheetPages.push(page); // sheet goes at the FRONT of the file
    page.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: navy });
    page.drawRectangle({ x: 0, y: H - 68, width: W, height: 4, color: orange });
    page.drawText('MP DEVELOPERS', { x: M, y: H - 30, size: 11, font: bold, color: rgb(1, 1, 1) });
    page.drawText(first ? 'Document Approval & Signature Sheet' : 'Document Approval & Signature Sheet (continued)', { x: M, y: H - 49, size: 15, font: bold, color: rgb(1, 1, 1) });
    y = H - 92;
    if(first){
      const det = [
        ['Drawing No.', v.docDrawingNumber], ['Title', v.docTitle], ['Project', docData.project], ['Folder', docData.folderId ? folderPath(docData.folderId) : '—'],
        ['Document Category', docData.category], ['Version / Revision', `v${v.versionNo || 1}${v.revision ? ' / ' + v.revision : ''}`],
        ['File', v.fileName], ['Published', fmtStamp(tsMs(v.signedAt) || Date.now())]
      ];
      const colW = (W - 2 * M) / 2;
      det.forEach(([k, val], i) => {
        const cx = M + (i % 2) * colW, cy = y - Math.floor(i / 2) * 30;
        page.drawText(safe(k).toUpperCase(), { x: cx, y: cy, size: 7, font: bold, color: grey });
        page.drawText(fit(val || '—', font, 10, colW - 12), { x: cx, y: cy - 12, size: 10, font, color: text });
      });
      y -= Math.ceil(det.length / 2) * 30 + 14;
    }
    // table header
    page.drawRectangle({ x: M, y: y - 20, width: W - 2 * M, height: 20, color: rgb(0.918, 0.945, 0.984) });
    let cx = M;
    cols.forEach(c => { page.drawText(c.t, { x: cx + 6, y: y - 14, size: 8, font: bold, color: navy }); cx += c.w; });
    y -= 20;
  };
  newPage(true);
  rows.forEach((r, i) => {
    if(y - rowH < M + 40) newPage(false);
    const top = y;
    page.drawLine({ start: { x: M, y: top - rowH }, end: { x: W - M, y: top - rowH }, thickness: 0.6, color: line });
    let cx = M;
    page.drawText(String(i + 1), { x: cx + 6, y: top - 22, size: 9, font: bold, color: grey }); cx += cols[0].w;
    page.drawText(fit(r.name, bold, 10, cols[1].w - 10), { x: cx + 6, y: top - 22, size: 10, font: bold, color: text });
    if(r.role) page.drawText(fit(r.role, font, 8, cols[1].w - 10), { x: cx + 6, y: top - 35, size: 8, font, color: grey });
    cx += cols[1].w;
    page.drawText(fit(r.action, bold, 8.5, cols[2].w - 10), { x: cx + 6, y: top - 22, size: 8.5, font: bold, color: r.action.includes('Published') ? orange : navy });
    if(r.step) page.drawText(fit(r.step, font, 8, cols[2].w - 10), { x: cx + 6, y: top - 35, size: 8, font, color: grey });
    cx += cols[2].w;
    page.drawText(fit(fmtStamp(r.at), font, 8, cols[3].w - 8), { x: cx + 6, y: top - 22, size: 8, font, color: text });
    cx += cols[3].w;
    const img = sigImgs[i];
    const boxW = cols[4].w - 12, boxH = rowH - 14;
    if(img){
      const sc = Math.min(boxW / img.width, boxH / img.height);
      page.drawImage(img, { x: cx + 6 + (boxW - img.width * sc) / 2, y: top - 7 - boxH + (boxH - img.height * sc) / 2, width: img.width * sc, height: img.height * sc });
    } else {
      page.drawText('Approved electronically', { x: cx + 6, y: top - 26, size: 8.5, font, color: grey });
      page.drawText('(no signature on file)', { x: cx + 6, y: top - 38, size: 7.5, font, color: grey });
    }
    y = top - rowH;
  });
  // footers
  sheetPages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M + 22 }, end: { x: W - M, y: M + 22 }, thickness: 0.6, color: line });
    p.drawText(safe('Approved electronically in MP DMS. Signatures are reproduced from each person\'s registered signature.'), { x: M, y: M + 10, size: 7, font, color: grey });
    p.drawText(`Signature sheet ${i + 1} of ${sheetPages.length}`, { x: W - M - 80, y: M - 2, size: 7, font, color: grey });
    p.drawText(safe('Generated ' + fmtStamp(Date.now())), { x: M, y: M - 2, size: 7, font, color: grey });
  });
  return pdf.save();
}
// Builds the signed copy and makes it the file people open. Safe to run again.
async function addSignatureSheet(docId, versionId, opts){
  opts = opts || {};
  const vRef = db.collection('documents').doc(docId).collection('versions').doc(versionId);
  const dRef = db.collection('documents').doc(docId);
  try{
    // Read from the server (not the local cache) so a file published a moment ago shows as published.
    const fresh = ref => ref.get({ source: 'server' }).catch(() => ref.get());
    const [vSnap, dSnap] = await Promise.all([fresh(vRef), fresh(dRef)]);
    if(!vSnap.exists || !dSnap.exists) throw new Error('Document not found.');
    const v = vSnap.data(), docData = dSnap.data();
    const kind = fileKind(v.fileName);
    if(!kind){
      await vRef.update({ signSheetStatus: 'not_supported', signSheetError: null });
      toast(`Published. A signature sheet can only be added to PDF, JPG or PNG files — "${v.fileName}" is a ${String(v.fileName).split('.').pop().toUpperCase()} file.`, 'ok');
      refreshDocPage(docId);
      return;
    }
    // Called straight after publishing (opts.justPublished) we already know it's published.
    if(v.status !== 'published' && !opts.justPublished) throw new Error('Only published files get a signature sheet.');
    const rows = signatureRows(v);
    const missing = rows.filter(r => !r.signatureURL).map(r => r.name);
    if(!opts.silent) toast('Adding the signature sheet…', 'ok');
    const PDFLib = await loadPdfLib();
    const src = await fileBytes(v.filePath, v.fileURL);
    const bytes = await buildSignedPdf(PDFLib, v, docData, src, kind, rows);
    const baseName = String(v.fileName || 'document').replace(/\.[^.]+$/, '');
    const path = `documents/${docId}/${versionId}/signed_${baseName}.pdf`;
    const ref = storage.ref(path);
    await ref.put(new Blob([bytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
    const url = await ref.getDownloadURL();
    const ts = firebase.firestore.FieldValue.serverTimestamp();
    await vRef.update({ signedFileURL: url, signedFilePath: path, signSheetStatus: 'done', signSheetError: null, signSheetAt: ts, signSheetMissing: missing });
    if(docData.currentVersionId === versionId) await dRef.update({ currentFileURL: url, currentFileName: `signed_${baseName}.pdf`, updatedAt: ts });
    toast(missing.length
      ? `Signature sheet added. No signature on file for: ${missing.join(', ')} — they show as "Approved electronically". Upload their signatures in Manage Users, then use "Add signature sheet" again.`
      : 'Signature sheet added to the published file.', 'ok');
  } catch(err){
    console.error('signature sheet:', err);
    vRef.update({ signSheetStatus: 'failed', signSheetError: err.message }).catch(() => {});
    toast('Published, but the signature sheet could not be added: ' + err.message, 'err');
  }
  refreshDocPage(docId);
}
function onDocumentPublished(docId, versionId){
  if(dmsParams.signatureSheet === false) return;
  addSignatureSheet(docId, versionId, { justPublished: true });
}

/* ============================================================
   IMPORT OLD DOCUMENTS (admin)
   Bulk-loads old files straight in as Published — no review/approval,
   no notifications. A folder chosen from the computer is recreated as
   DMS subfolders (existing folders with the same name are reused, so the
   import can be re-run safely). Each file gets:
     documents/{id}            status 'published', imported: true
     versions/{v}              one completed step "Imported (legacy document)"
     versions/{v}/history/{h}  action 'imported'  (null → Published)
============================================================ */
let imItems = [];          // { file, dirs:[...], name, size, skip:null|reason, state, folderId, docId }
let imRunning = false, imStopRequested = false;
const IM_JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i;

function goImportToFolder(folderId){
  switchView('importDocsView');
  populateImportDest();
  const sel = document.getElementById('imDest');
  if(sel && folderId) { sel.value = folderId; imRenderPreview(); }
}
function populateImportDest(){
  if(!currentUser) return;
  fillFolderSelect('imDest', folderOptions(false), 'Select a DMS folder&hellip;');
}
function imFmtSize(b){
  if(b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if(b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function imCleanName(n){ return String(n || '').replace(/[\/\\]/g, '-').trim().slice(0, 80) || 'Folder'; }
function imFilesChosen(input){
  if(imRunning){ toast('An import is running. Stop it or wait until it finishes.', 'err'); input.value = ''; return; }
  const files = [...(input.files || [])];
  input.value = '';
  if(!files.length) return;
  imItems = files.map(file => {
    const parts = String(file.webkitRelativePath || file.name).split('/').filter(Boolean);
    return { file, rel: parts, name: file.name, size: file.size, state: 'waiting', skip: null };
  });
  const top = imItems[0].rel.length > 1 ? imItems[0].rel[0] : '';
  document.getElementById('imPicked').innerHTML = top
    ? `Folder <b>${escapeHtml(top)}</b> &middot; ${files.length} file${files.length === 1 ? '' : 's'}`
    : `${files.length} file${files.length === 1 ? '' : 's'} chosen`;
  imRenderPreview();
}
function imDirsFor(it){
  let dirs = it.rel.slice(0, -1).map(imCleanName);
  if(!document.getElementById('imKeepTop').checked) dirs = dirs.slice(1);
  return dirs;
}
function imSkipReason(it){
  const n = it.name;
  if(IM_JUNK.test(n) || n.startsWith('~$') || n.startsWith('.')) return 'System / temporary file';
  if(it.size === 0) return 'Empty file (0 bytes)';
  if(!document.getElementById('imIgnoreLimits').checked){
    const issue = validateUploadFile(it.file);
    if(issue) return issue.replace(/This file is/, 'File is');
  }
  return null;
}
function imDocNo(name){
  const base = name.replace(/\.[^.]+$/, '');
  const mode = document.getElementById('imDocNo').value;
  if(mode === 'blank') return '';
  if(mode === 'name') return base;
  return base.split(/\s+/)[0] || base;
}
function imRenderPreview(){
  const card = document.getElementById('imSummaryCard'), tcard = document.getElementById('imTableCard');
  if(!imItems.length){ card.classList.add('hidden'); tcard.classList.add('hidden'); return; }
  const destId = document.getElementById('imDest').value;
  const destPath = destId ? folderPath(destId) : '(choose a DMS folder)';
  if(!imRunning) imItems.forEach(it => { if(it.state === 'waiting' || it.state === 'skipped') { it.skip = imSkipReason(it); it.state = it.skip ? 'skipped' : 'waiting'; } });
  const ok = imItems.filter(it => !it.skip), skipped = imItems.length - ok.length;
  const newDirs = new Set(ok.map(it => imDirsFor(it).join('/')).filter(Boolean));
  const total = ok.reduce((a, it) => a + it.size, 0);
  const project = document.getElementById('imProject').value || (destId ? projectNameForFolder(destId) : '');
  document.getElementById('imSummary').innerHTML =
    `<b>${ok.length}</b> file${ok.length === 1 ? '' : 's'} (${imFmtSize(total)}) will be imported as <b>Published</b> into <b>${escapeHtml(destPath)}</b>` +
    (newDirs.size ? `, in ${newDirs.size} subfolder${newDirs.size === 1 ? '' : 's'}` : '') + '.' +
    (project ? ` Project: <b>${escapeHtml(project)}</b>.` : '') +
    (skipped ? `<br><span style="color:var(--red);">${skipped} file${skipped === 1 ? '' : 's'} will be skipped</span> (reason shown in the list).` : '');
  card.classList.remove('hidden'); tcard.classList.remove('hidden');
  const SHOW = 1000;
  const rows = imItems.slice(0, SHOW).map((it, i) => {
    const loc = [destId ? folderPath(destId).replace(/\/$/, '') : '…', ...imDirsFor(it)].join('/') + '/';
    return `<tr><td>${i + 1}</td><td><div style="font-weight:600;">${escapeHtml(it.name)}</div><div class="fm-muted" style="font-size:11.5px;">${escapeHtml(loc)}${!it.skip ? ' &middot; No. ' + escapeHtml(imDocNo(it.name) || '—') : ''}</div></td>
      <td>${imFmtSize(it.size)}</td><td id="imSt${i}">${imStatusHtml(it)}</td></tr>`;
  }).join('');
  document.getElementById('imTableBody').innerHTML = rows +
    (imItems.length > SHOW ? `<tr><td colspan="4" class="fm-muted">&hellip; and ${imItems.length - SHOW} more (not listed, but they will be imported).</td></tr>` : '');
}
function imStatusHtml(it){
  if(it.state === 'skipped') return `<span class="im-st skip">Skipped: ${escapeHtml(it.skip || '')}</span>`;
  if(it.state === 'done') return `<span class="im-st ok">&#10003; Published</span>${it.docId ? ` &middot; <a onclick="openDocumentDetail('${it.docId}')">open</a>` : ''}`;
  if(it.state === 'exists') return `<span class="im-st skip">Already in DMS (skipped)</span>`;
  if(it.state === 'error') return `<span class="im-st err">Failed: ${escapeHtml(it.error || '')}</span>`;
  if(it.state === 'uploading') return `<span class="im-st run">Uploading&hellip; ${it.pct || 0}%</span>`;
  return '<span class="im-st">Waiting</span>';
}
function imSetState(i, state, extra){
  Object.assign(imItems[i], { state }, extra || {});
  const el = document.getElementById('imSt' + i);
  if(el) el.innerHTML = imStatusHtml(imItems[i]);
}
// Find or create the DMS folder for a path under the destination; one promise per path so parallel uploads share it.
function imEnsureFolder(destId, dirs, cache){
  if(!dirs.length) return Promise.resolve(destId);
  const key = dirs.join('/');
  if(cache.has(key)) return cache.get(key);
  const p = imEnsureFolder(destId, dirs.slice(0, -1), cache).then(parentId => {
    const name = dirs[dirs.length - 1];
    const existing = childFolders(parentId).find(f => f.name.trim().toLowerCase() === name.toLowerCase())
      || (cache.created || []).find(c => c.parentId === parentId && c.name.toLowerCase() === name.toLowerCase());
    if(existing) return existing.id;
    const now = firebase.firestore.FieldValue.serverTimestamp();
    return allocateFolderNo().then(no => db.collection('folders').add({
      name, parentId, folderNo: no, description: 'Created by Import Old Documents.',
      permissions: { users: [], roles: [], departments: [], applyToSubfolders: true },
      reviewers: [], approvers: [], subscribers: [],
      createdBy: currentUser.uid, createdByName: currentUser.name, createdAt: now, updatedAt: now
    })).then(ref => { (cache.created = cache.created || []).push({ id: ref.id, parentId, name }); fmExpanded.add(parentId); return ref.id; });
  });
  cache.set(key, p);
  return p;
}
// File names already in a folder (lower-case), fetched once per folder.
function imExistingNames(folderId, nameCache){
  if(!nameCache.has(folderId)){
    nameCache.set(folderId, db.collection('documents').where('folderId', '==', folderId).get()
      .then(snap => new Set(snap.docs.map(d => String(d.data().currentFileName || '').toLowerCase())))
      .catch(() => new Set()));
  }
  return nameCache.get(folderId);
}
function imUploadOne(i, folderId, opts){
  const it = imItems[i], file = it.file;
  const docRef = db.collection('documents').doc();
  const versionRef = docRef.collection('versions').doc();
  const storagePath = `documents/${docRef.id}/${versionRef.id}/${file.name}`;
  const task = storage.ref(storagePath).put(file);
  imItems[i].task = task;
  task.on('state_changed', snap => {
    const pct = Math.round(snap.bytesTransferred / (snap.totalBytes || 1) * 100);
    if(pct !== it.pct) imSetState(i, 'uploading', { pct });
  });
  return task.then(() => {
    const bucket = task.snapshot.ref.bucket;
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(storagePath)}?alt=media`;
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const ts = firebase.firestore.Timestamp.now();
    const title = file.name.replace(/\.[^.]+$/, '');
    const docNo = imDocNo(file.name);
    const project = opts.project || projectNameForFolder(folderId) || opts.destProject || '';
    const remarks = 'Old document imported directly as Published (no review/approval).';
    const steps = [{ key: 'import', label: 'Imported (legacy document)', stage: 0, role: null, uid: currentUser.uid,
      decision: 'approved', decidedBy: currentUser.uid, decidedByName: currentUser.name, decidedAt: ts, remarks }];
    const batch = db.batch();
    batch.set(docRef, {
      title, drawingNumber: docNo, project, department: opts.department, category: opts.category, folderId,
      currentFileName: file.name, currentFileURL: url, currentRevision: opts.revision,
      currentVersionNo: 1, currentVersionId: versionRef.id, status: 'published', imported: true,
      createdBy: currentUser.uid, createdByName: currentUser.name, createdAt: now, updatedAt: now
    });
    batch.set(versionRef, {
      versionNo: 1, revision: opts.revision, fileName: file.name, fileURL: url, filePath: storagePath,
      uploadedBy: currentUser.uid, uploadedByName: currentUser.name, uploadedAt: now,
      status: 'published', currentStage: 1, steps, workflowConfigName: 'Import Old Documents', imported: true,
      originalModifiedAt: file.lastModified ? firebase.firestore.Timestamp.fromMillis(file.lastModified) : null,
      originalPath: (it.rel || []).join('/'),
      signedBy: currentUser.name, signedByUid: currentUser.uid, signedByEmail: currentUser.email || null, signedAt: ts,
      supersededBy: null, docTitle: title, docDrawingNumber: docNo, docProject: project, docId: docRef.id, docFolderId: folderId
    });
    batch.set(versionRef.collection('history').doc(), {
      action: 'imported', actor: currentUser.uid, actorName: currentUser.name, timestamp: now,
      remarks, fromStatus: null, toStatus: 'published', allocatedTo: ''
    });
    return batch.commit().then(() => docRef.id);
  });
}
async function startImport(){
  if(imRunning) return;
  if(!fmIsAdmin()){ toast('Only Admin can import old documents.', 'err'); return; }
  const destId = document.getElementById('imDest').value;
  if(!destId){ toast('Please choose the DMS folder to import into.', 'err'); return; }
  imRenderPreview();
  const todo = imItems.map((it, i) => i).filter(i => !imItems[i].skip && imItems[i].state !== 'done' && imItems[i].state !== 'exists');
  if(!todo.length){ toast('Nothing left to import.', 'err'); return; }
  if(!confirm(`Import ${todo.length} file${todo.length === 1 ? '' : 's'} into ${folderPath(destId)} as Published?\n\nThey will skip review and approval. Keep this page open until it finishes.`)) return;
  const opts = {
    project: document.getElementById('imProject').value,
    destProject: projectNameForFolder(destId),
    department: document.getElementById('imDepartment').value,
    category: document.getElementById('imCategory').value,
    revision: document.getElementById('imRevision').value.trim(),
    skipDup: document.getElementById('imSkipDup').checked
  };
  imRunning = true; imStopRequested = false;
  window.addEventListener('beforeunload', imBeforeUnload);
  ['imStartBtn', 'imClearBtn'].forEach(id => document.getElementById(id).disabled = true);
  document.getElementById('imStopBtn').classList.remove('hidden');
  document.getElementById('imProgWrap').classList.remove('hidden');
  const folderCache = new Map(), nameCache = new Map();
  let done = 0, failed = 0, existed = 0, finished = 0, pos = 0;
  const progress = () => {
    const pct = Math.round(finished / todo.length * 100);
    document.getElementById('imProgBar').style.width = pct + '%';
    document.getElementById('imProgText').textContent = `${finished} of ${todo.length} processed · ${done} published · ${existed} already there · ${failed} failed`;
  };
  progress();
  const worker = async () => {
    while(pos < todo.length && !imStopRequested){
      const i = todo[pos++];
      try {
        const folderId = await imEnsureFolder(destId, imDirsFor(imItems[i]), folderCache);
        if(opts.skipDup){
          const names = await imExistingNames(folderId, nameCache);
          if(names.has(imItems[i].name.toLowerCase())){ imSetState(i, 'exists'); existed++; finished++; progress(); continue; }
          names.add(imItems[i].name.toLowerCase()); // guards against the same name twice in one run
        }
        imSetState(i, 'uploading', { pct: 0 });
        const docId = await imUploadOne(i, folderId, opts);
        imSetState(i, 'done', { docId }); done++;
      } catch(err) {
        imSetState(i, 'error', { error: err && err.code === 'storage/canceled' ? 'Stopped' : (err && err.message) || String(err) }); failed++;
      }
      finished++; progress();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  imRunning = false;
  window.removeEventListener('beforeunload', imBeforeUnload);
  ['imStartBtn', 'imClearBtn'].forEach(id => document.getElementById(id).disabled = false);
  document.getElementById('imStopBtn').classList.add('hidden');
  const msg = `${imStopRequested ? 'Import stopped' : 'Import finished'}: ${done} published${existed ? `, ${existed} already there` : ''}${failed ? `, ${failed} failed` : ''}.`;
  toast(msg + (failed ? ' Click Start import again to retry the failed ones.' : ''), failed ? 'err' : 'ok');
  document.getElementById('imProgText').textContent = msg;
}
function stopImport(){
  if(!imRunning) return;
  imStopRequested = true;
  toast('Stopping after the files currently uploading…', 'ok');
}
function clearImport(){
  if(imRunning) return;
  imItems = [];
  document.getElementById('imPicked').textContent = 'Nothing chosen yet.';
  document.getElementById('imProgWrap').classList.add('hidden');
  imRenderPreview();
}
function imBeforeUnload(e){ e.preventDefault(); e.returnValue = 'An import is still running.'; return e.returnValue; }
