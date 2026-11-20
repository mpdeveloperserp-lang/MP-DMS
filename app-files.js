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
  maxFileSizeMB: 50, reviewTatDays: 2, approvalTatDays: 2, folderNoDigits: 7
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
let projectMastersLoaded = false;
let projectSyncInFlight = new Set(); // project master IDs whose folder is being created/renamed

/* ---------------- small helpers ---------------- */
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
  fmKmOpen = new Set(['pendReview', 'pendApproval']); fmOverdueOnly = false; fmSearchState = null; fmLinksPanel = null; fmShowAllDocs = false;
  fmReportRows = null; fmActiveReport = null; fmMoveCandidates = []; fmTransferFrom = null;
  dmsParams = { ...DEFAULT_DMS_PARAMS }; emailConfig = { ...DEFAULT_EMAIL_CONFIG };
}

function onFoldersChanged(){
  syncProjectFolders();
  if(fmActiveFolderId && !foldersById.has(fmActiveFolderId)) openFmDashboard();
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
    el.innerHTML = `<div class="master-empty">No folders yet.${fmIsAdmin() ? `<br><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="openCreateFolderModal(null)">+ Create root folder</button>` : ''}</div>`;
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
  if(!foldersById.has(id)) return;
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
  if(!opts.noSwitch && !fmViewActive('filesView')) switchView('filesView');
  renderFmTree(); renderFmLinksPanel(); renderFmMain();
}
// Files > All Documents — the full documents table (formerly its own page)
function openFmAllDocs(){
  fmSearchState = null; fmActiveFolderId = null; fmLinksPanel = null; fmShowAllDocs = true;
  if(fmFolderDocsUnsub){ fmFolderDocsUnsub(); fmFolderDocsUnsub = null; }
  fmFolderDocs = null;
  if(!fmViewActive('filesView')) switchView('filesView');
  renderFmTree(); renderFmLinksPanel(); renderFmMain();
}
function openFmDashboard(){
  fmSearchState = null; fmActiveFolderId = null; fmLinksPanel = null; fmShowAllDocs = false;
  if(fmFolderDocsUnsub){ fmFolderDocsUnsub(); fmFolderDocsUnsub = null; }
  fmFolderDocs = null;
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
      ${fmIsAdmin() ? `<a onclick="openFolderPermModal('${id}')">Permissions</a><span class="sep">|</span>
      <a onclick="openCreateFolderModal('${id}')">New Subfolder</a><span class="sep">|</span>
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
function runFmSearch(crit, label){
  fmSearchState = { crit, label, results: null };
  fmShowAllDocs = false;
  fmLinksPanel = null; renderFmLinksPanel();
  if(!fmViewActive('filesView')) switchView('filesView');
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
function openCreateFolderModal(parentId){
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
      if(fmActiveFolderId === id) openFmDashboard();
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
  if(roots.length === 0){ body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="ic">&#128193;</div><b>No root folders yet</b><div>Create the top-level folders (e.g. ASSETS, Design, ENGG, Finance, HR, LEGAL) to start organising files.</div></div></td></tr>`; return; }
  body.innerHTML = roots.map(f => `<tr>
    <td><span class="drawing-code">${fmtFolderNo(f.folderNo)}</span></td>
    <td><span style="display:inline-flex; align-items:center; gap:8px;">${FOLDER_SVG}${escapeHtml(f.name)}${linkedProjectMaster(f) ? ' <span class="fm-tag project">Project</span>' : ''}</span></td>
    <td>${descendantIds(f.id).length}</td>
    <td><span class="fm-tag ${isFolderRestricted(f.id) ? 'restricted' : 'open'}">${isFolderRestricted(f.id) ? 'Restricted' : 'Open'}</span></td>
    <td>${escapeHtml(f.createdByName || '—')}</td>
    <td style="text-align:right; white-space:nowrap;">
      <button class="icon-btn-sm" onclick="openFmFolder('${f.id}')" title="Open">&#128194;</button>
      <button class="icon-btn-sm" onclick="openRenameFolderModal('${f.id}')" title="Rename">&#9999;&#65039;</button>
      <button class="icon-btn-sm" onclick="deleteFolder('${f.id}')" title="Delete">&#128465;&#65039;</button>
    </td></tr>`).join('');
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
            remarks: `Moved from ${srcPath} to ${destPath}`, toStatus: d.status
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
      remarks: `Pending task reassigned from ${userName(from)} to ${userName(to)} (Transfer Rights)`, toStatus: v.status
    });
  });
  batch.commit().then(() => {
    notifyUser(to, `${userName(from)}'s rights on ${folderIds.length} folder(s)${tasks.length ? ` and ${tasks.length} pending task(s)` : ''} were transferred to you.`, null);
    toast('Rights transferred.', 'ok');
    document.getElementById('trResult').classList.add('hidden');
    fmTransferFrom = null;
  }).catch(err => toast('Transfer failed: ' + err.message, 'err'));
}
