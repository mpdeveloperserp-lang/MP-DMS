/* ============================================================
   HELPERS
============================================================ */
function escapeHtml(str){
  if(str===undefined || str===null) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// For embedding admin-typed text (workflow step labels, etc.) as a
// single-quoted JS string literal inside an inline onclick="" attribute —
// escapes backslashes/quotes so labels containing them don't break the
// generated markup.
function escapeJs(str){
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtDate(ts){
  const ms = ts && ts.toMillis ? ts.toMillis() : (ts instanceof Date ? ts.getTime() : null);
  if(!ms) return '—';
  return new Date(ms).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function timeAgo(ts){
  const ms = ts && ts.toMillis ? ts.toMillis() : null;
  if(!ms) return '—';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs/24) + 'd ago';
}
// When the item entered its CURRENT stage: the latest decision on an earlier
// stage, or the upload time if it's still on the first stage.
function stageStartMs(v){
  let ms = v.uploadedAt && v.uploadedAt.toMillis ? v.uploadedAt.toMillis() : 0;
  (v.steps || []).forEach(s => {
    if(s.stage < v.currentStage && s.decidedAt && s.decidedAt.toMillis) ms = Math.max(ms, s.decidedAt.toMillis());
  });
  return ms;
}
// Turnaround time (days) per status — from Set Parameter, default 2.
function tatDaysFor(status){
  const p = (typeof dmsParams !== 'undefined' && dmsParams) ? dmsParams : {};
  const v = Number(status === 'pending_approval' ? p.approvalTatDays : p.reviewTatDays);
  return isFinite(v) && v > 0 ? v : 2;
}
function isOverdue(v){
  const ms = stageStartMs(v);
  return ms > 0 && (Date.now() - ms) > tatDaysFor(v.status) * 24*60*60*1000;
}
function timeAgoMs(ms){ return ms ? timeAgo({ toMillis: () => ms }) : '—'; }
// A workflow step is either assigned to a specific user (folder reviewers /
// approvers — step.uid) or to a role (Document Category workflows — step.role).
function isStepAssignedToMe(s){
  if(!currentUser) return false;
  if(s.uid) return s.uid === currentUser.uid;
  return getUserRoles(currentUser).includes(s.role);
}
function stepAssigneeLabel(s){
  if(s.uid) return (typeof userName === 'function') ? userName(s.uid) : 'a specific user';
  return ROLE_LABELS[s.role] || s.role;
}
function humanizeAction(a){
  return { uploaded:'uploaded the document', step_approved:'approved a step', step_rejected:'rejected the document', resubmitted:'submitted a revised version', moved:'moved the file', reassigned:'reassigned a pending task' }[a] || a;
}
// A user's EFFECTIVE roles: their primary `role` plus whatever's in their
// `roles` array (additional roles), deduped. Deliberately does NOT special-
// case 'admin' — the admin check stays a separate, untouched `role ===
// 'admin'` comparison everywhere else in the app (and in Firestore rules),
// so this helper only ever affects non-admin capability matching (workflow
// steps, page access, notifications) and never the admin security boundary.
function getUserRoles(user){
  if(!user) return [];
  const set = new Set();
  if(user.role) set.add(user.role);
  (user.roles || []).forEach(r => { if(r) set.add(r); });
  return [...set];
}

/* ============================================================
   NOTIFICATIONS
============================================================ */
function notifyRoles(roles, message, docId){
  roles.forEach(role => {
    db.collection('notifications').add({
      forRole: role, toUid: null, message, docId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), readBy: []
    });
  });
}
function notifyUser(uid, message, docId){
  db.collection('notifications').add({
    forRole: null, toUid: uid, message, docId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), readBy: []
  });
}

// Notify whoever owns a set of workflow steps — role-based steps go to the
// role, user-based steps (folder reviewers/approvers) go to the user — and
// queue an email if Email Configuration has it switched on.
function notifyTask(steps, message, docId){
  const roles = [...new Set((steps || []).filter(s => !s.uid && s.role).map(s => s.role))];
  const uids = [...new Set((steps || []).filter(s => s.uid).map(s => s.uid))];
  if(roles.length) notifyRoles(roles, message, docId);
  uids.forEach(u => notifyUser(u, message, docId));
  if(typeof queueEmail === 'function') queueEmail('taskAssigned', { roles, uids }, message, docId);
}

let notifMap = new Map();
function listenNotifications(){
  // One listener per effective role (primary + any additional) — a user
  // with several roles should see notifications addressed to any of them.
  getUserRoles(currentUser).forEach(roleId => {
    const unsub = db.collection('notifications').where('forRole','==',roleId).orderBy('createdAt','desc').limit(30)
      .onSnapshot(snap => { snap.docChanges().forEach(upsertNotif); renderNotifications(); },
        err => console.error('notif(role) listener:', err));
    activeSessionUnsubs.push(unsub);
  });
  const unsub2 = db.collection('notifications').where('toUid','==',currentUser.uid).orderBy('createdAt','desc').limit(30)
    .onSnapshot(snap => { snap.docChanges().forEach(upsertNotif); renderNotifications(); },
      err => console.error('notif(uid) listener:', err));
  activeSessionUnsubs.push(unsub2);
}
function upsertNotif(ch){
  if(ch.type === 'removed') notifMap.delete(ch.doc.id);
  else notifMap.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
}
function renderNotifications(){
  const list = Array.from(notifMap.values())
    .sort((a,b) => ((b.createdAt&&b.createdAt.toMillis)?b.createdAt.toMillis():0) - ((a.createdAt&&a.createdAt.toMillis)?a.createdAt.toMillis():0))
    .slice(0, 30);
  const unread = list.filter(n => !(n.readBy||[]).includes(currentUser.uid));
  const dot = document.getElementById('notifDot');
  if(unread.length > 0){ dot.textContent = unread.length > 9 ? '9+' : String(unread.length); dot.classList.remove('hidden'); }
  else dot.classList.add('hidden');

  const wrap = document.getElementById('notifList');
  if(list.length === 0){
    wrap.innerHTML = '<div class="empty-state" style="padding:26px;"><b>No notifications yet</b></div>';
    return;
  }
  wrap.innerHTML = list.map(n => {
    const unreadCls = (n.readBy||[]).includes(currentUser.uid) ? '' : 'unread';
    return `<div class="notif-item ${unreadCls}" onclick="handleNotifClick('${n.id}','${n.docId}')">
      <div class="nt">${escapeHtml(n.message)}</div>
      <div class="ntime">${timeAgo(n.createdAt)}</div>
    </div>`;
  }).join('');
}
function handleNotifClick(notifId, docId){
  db.collection('notifications').doc(notifId).update({ readBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid) });
  document.getElementById('notifPanel').classList.remove('active');
  if(docId && docId !== 'null' && docId !== 'undefined') openDocumentDetail(docId);
}
function toggleNotifPanel(){
  document.getElementById('notifPanel').classList.toggle('active');
}
document.addEventListener('click', e => {
  const panel = document.getElementById('notifPanel');
  const btn = document.getElementById('notifBtn');
  if(panel.classList.contains('active') && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
    panel.classList.remove('active');
  }
});

/* ============================================================
   MY APPROVAL QUEUE
============================================================ */
let queueMap = new Map();
// Files waiting for review/approval. Watches top-level documents whose status
// is pending (indexed automatically by Firestore, so no manual index is needed),
// then watches each one's CURRENT version for its workflow steps.
// queueMap is keyed by version ID.
const PENDING_STATUSES = ['pending_review', 'pending_approval'];
function listenQueue(){
  const versionWatchers = new Map(); // "docId/versionId" -> { unsub, versionId }
  const unsub = db.collection('documents').where('status', 'in', PENDING_STATUSES).onSnapshot(snap => {
    const live = new Set();
    snap.docs.forEach(d => {
      const data = d.data();
      if(!data.currentVersionId) return;
      const key = d.id + '/' + data.currentVersionId;
      live.add(key);
      if(versionWatchers.has(key)) return;
      const vUnsub = db.collection('documents').doc(d.id).collection('versions').doc(data.currentVersionId).onSnapshot(vs => {
        const v = vs.exists ? vs.data() : null;
        if(v && PENDING_STATUSES.includes(v.status)) queueMap.set(vs.id, { id: vs.id, docId: d.id, ...v });
        else queueMap.delete(vs.id);
        renderQueue();
      }, err => console.error('queue version listener:', err));
      versionWatchers.set(key, { unsub: vUnsub, versionId: data.currentVersionId });
    });
    // Stop watching versions that are no longer pending (approved, rejected, superseded)
    for(const [key, w] of versionWatchers){
      if(!live.has(key)){ try{ w.unsub(); }catch(e){} versionWatchers.delete(key); queueMap.delete(w.versionId); }
    }
    renderQueue();
  }, err => {
    console.error('queue listener:', err);
    toast('Could not load files waiting for review/approval: ' + err.message, 'err');
  });
  activeSessionUnsubs.push(() => {
    unsub();
    versionWatchers.forEach(w => { try{ w.unsub(); }catch(e){} });
    versionWatchers.clear();
  });
}
// The approval queue now lives on the Files dashboard (Knowledge Management)
// in app-files.js. This only works out how many items wait on the current
// user, for the badge on the Files menu item, then asks the dashboard to redraw.
// Admin can act on any pending step (on behalf of whoever it is assigned to).
function myActionableVersions(){
  if(!currentUser) return [];
  const isAdminUser = currentUser.role === 'admin';
  return Array.from(queueMap.values()).filter(v =>
    (v.steps||[]).some(s => s.stage === v.currentStage && s.decision === 'pending' && (isStepAssignedToMe(s) || isAdminUser))
  );
}
// The step the current user would decide on: their own if assigned, else (Admin) the first pending one.
function myActionStep(v){
  const pending = (v.steps||[]).filter(s => s.stage === v.currentStage && s.decision === 'pending');
  return pending.find(isStepAssignedToMe) || (currentUser && currentUser.role === 'admin' ? pending[0] : null) || null;
}
function renderQueue(){
  if(!currentUser) return;
  const mine = myActionableVersions();
  const badge = document.getElementById('queueBadge');
  if(badge){ badge.textContent = mine.length; badge.classList.toggle('hidden', mine.length === 0); }
  if(typeof onQueueDataChanged === 'function') onQueueDataChanged();
}

/* ============================================================
   ALL DOCUMENTS
============================================================ */
let allDocsSnapshot = [];
function listenAllDocuments(){
  const unsub = db.collection('documents').orderBy('updatedAt','desc').limit(100).onSnapshot(snap => {
    allDocsSnapshot = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDocsTable();
    renderQueue();
    refreshMasterDataPanels(); // "in use" status depends on this data
  }, err => {
    console.error('documents listener:', err);
    document.getElementById('docsTableBody').innerHTML = `<tr><td colspan="7"><div class="empty-state"><b>Could not load documents</b></div></td></tr>`;
  });
  activeSessionUnsubs.push(unsub);
}
let docFilters = { folder: '', project: '', department: '', category: '', status: '' };
function applyDocFilters(){
  docFilters.folder = document.getElementById('filterFolder') ? document.getElementById('filterFolder').value : '';
  docFilters.project = document.getElementById('filterProject').value;
  docFilters.department = document.getElementById('filterDepartment').value;
  docFilters.category = document.getElementById('filterCategory').value;
  docFilters.status = document.getElementById('filterStatus').value;
  renderDocsTable();
}
function clearDocFilters(){
  docFilters = { folder: '', project: '', department: '', category: '', status: '' };
  if(document.getElementById('filterFolder')) document.getElementById('filterFolder').value = '';
  document.getElementById('filterProject').value = '';
  document.getElementById('filterDepartment').value = '';
  document.getElementById('filterCategory').value = '';
  document.getElementById('filterStatus').value = '';
  renderDocsTable();
}
// Jump to Files > All Documents pre-filtered by status — used by the clickable stat
// cards on My Approval Queue (e.g. "Published documents").
function goToDocumentsFiltered(statusKey){
  clearDocFilters();
  docFilters.status = statusKey || '';
  const sel = document.getElementById('filterStatus');
  if(sel) sel.value = docFilters.status;
  if(typeof openFmAllDocs === 'function') openFmAllDocs();
  renderDocsTable();
}

function populateStatusFilterOptions(){
  const sel = document.getElementById('filterStatus');
  if(!sel) return;
  const prevValue = sel.value;
  sel.innerHTML = '<option value="">All statuses</option>' +
    Object.keys(STATUS_LABELS).map(key => `<option value="${key}">${escapeHtml(STATUS_LABELS[key])}</option>`).join('');
  sel.value = prevValue;
}

function renderDocsTable(){
  const body = document.getElementById('docsTableBody');
  if(!body || !currentUser) return;
  const visibleDocs = allDocsSnapshot.filter(d => typeof canAccessDoc === 'function' ? canAccessDoc(d) : true);
  const limitNote = document.getElementById('docsLimitNote');
  if(limitNote) limitNote.classList.toggle('hidden', allDocsSnapshot.length < 100);
  const inFolder = d => {
    if(!docFilters.folder) return true;
    if(docFilters.folder === '__unfiled__') return !d.folderId;
    if(d.folderId === docFilters.folder) return true;
    return typeof descendantIds === 'function' && descendantIds(docFilters.folder).includes(d.folderId);
  };
  const filtered = visibleDocs.filter(d =>
    inFolder(d) &&
    (!docFilters.project || d.project === docFilters.project) &&
    (!docFilters.department || d.department === docFilters.department) &&
    (!docFilters.category || d.category === docFilters.category) &&
    (!docFilters.status || d.status === docFilters.status)
  );
  if(visibleDocs.length === 0){
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="ic">&#128193;</div><b>No documents yet</b><div>Open a folder and click <b>+ Upload</b>.</div></div></td></tr>`;
    return;
  }
  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="ic">&#128269;</div><b>No documents match these filters</b><div><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="clearDocFilters()">Clear filters</button></div></div></td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(d => `
    <tr onclick="openDocumentDetail('${d.id}')">
      <td><span class="drawing-code">${escapeHtml(d.drawingNumber||'—')}</span></td>
      <td>${escapeHtml(d.title||'—')}</td>
      <td>${escapeHtml(typeof folderPath === 'function' ? folderPath(d.folderId) : '—')}</td>
      <td>${escapeHtml(d.project||'—')}</td>
      <td>v${d.currentVersionNo||1}</td>
      <td><span class="badge st-${d.status}"><span class="dot"></span>${STATUS_LABELS[d.status]||d.status}</span></td>
      <td>${timeAgo(d.updatedAt)}</td>
    </tr>`).join('');
}

/* ============================================================
   DOCUMENT DETAIL MODAL
============================================================ */
function openDocumentDetail(docId){
  activeDocId = docId;
  const docRef = db.collection('documents').doc(docId);
  document.getElementById('detailBody').innerHTML = `<div class="empty-state"><b>Loading&hellip;</b></div>`;
  openModal('detailModalOverlay');
  Promise.all([ docRef.get(), docRef.collection('versions').orderBy('versionNo','desc').get() ])
    .catch(err => { document.getElementById('detailBody').innerHTML = `<div class="empty-state"><b>Could not open this document</b><div>${escapeHtml(err.message)}</div></div>`; return [null, null]; })
    .then(([docSnap, versionsSnap]) => {
      if(!docSnap) return;
      if(!docSnap.exists){
        document.getElementById('detailBody').innerHTML = '<div class="empty-state"><b>Document not found</b></div>';
        return;
      }
      const docData = docSnap.data();
      if(typeof canAccessDoc === 'function' && !canAccessDoc(docData)){
        document.getElementById('detailTitle').textContent = 'Restricted';
        document.getElementById('detailBody').innerHTML = `<div class="empty-state"><div class="ic">&#128274;</div><b>You don't have access to this folder</b><div>Ask an Admin to add you under the folder's Permissions.</div></div>`;
        return;
      }
      const versions = versionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const latest = versions[0];
      document.getElementById('detailTitle').textContent = `${docData.drawingNumber} — ${docData.title}`;
      docRef.collection('versions').doc(latest.id).collection('history').orderBy('timestamp','asc').get()
        .then(histSnap => renderDetail(docData, versions, latest, histSnap.docs.map(d => d.data())));
    });
}

function renderDetail(docData, versions, latest, history){
  const canResubmit = latest.status === 'rejected' && (currentUser.uid === docData.createdBy || currentUser.role === 'admin');
  const maxStage = Math.max(...latest.steps.map(s => s.stage));

  // Group this document's OWN steps by stage (not the live global config —
  // an admin may have reconfigured the workflow since this document was
  // uploaded; this document keeps the shape it was created with).
  const stageNumbers = [...new Set(latest.steps.map(s => s.stage))].sort((a,b) => a-b);
  const stageNodes = stageNumbers.map(stageNum => {
    const stepsInStage = latest.steps.filter(s => s.stage === stageNum);
    const label = stepsInStage.map(s => s.label).join(' + ');
    let cls = 'pending';
    if(stepsInStage.every(s => s.decision === 'approved')) cls = 'done';
    else if(stepsInStage.some(s => s.decision === 'rejected')) cls = 'rejected';
    else if(latest.status !== 'rejected' && stageNum === latest.currentStage) cls = 'active';
    const icon = cls === 'done' ? '&#10003;' : (cls === 'rejected' ? '&#10007;' : (stageNum+1));
    return `<div class="stage-node ${cls}"><div class="line"></div><div class="circle">${icon}</div><div class="lbl">${escapeHtml(label)}</div></div>`;
  }).join('');

  const myRolesForDetail = getUserRoles(currentUser);
  const stepRows = latest.steps.map(s => {
    let rowCls = s.decision !== 'pending' ? s.decision : (latest.status !== 'rejected' && s.stage === latest.currentStage ? 'active' : 'pending');
    const canAct = latest.status !== 'rejected' && latest.status !== 'published' && s.decision === 'pending' &&
      s.stage === latest.currentStage && (isStepAssignedToMe(s) || currentUser.role === 'admin');
    const isFinal = s.stage === maxStage;
    const icon = s.decision === 'approved' ? '&#10003;' : s.decision === 'rejected' ? '&#10007;' : (rowCls === 'active' ? '&#8987;' : '&hellip;');
    let extra;
    if(s.decision !== 'pending'){
      extra = `<div class="m">${s.decision === 'approved' ? 'Approved' : 'Rejected'} by <b>${escapeHtml(s.decidedByName||'')}</b> &middot; ${timeAgo(s.decidedAt)}</div>`;
      if(s.remarks) extra += `<div class="remarks">${escapeHtml(s.remarks)}</div>`;
    } else {
      extra = `<div class="m">Assigned to ${escapeHtml(stepAssigneeLabel(s))}${currentUser.role==='admin'?' <span style="color:var(--gold);">(admin override available)</span>':''}</div>`;
    }
    const actions = canAct ? `<div class="step-row-actions">
        <button class="btn btn-teal btn-sm" onclick="openDecisionModal('${activeDocId}','${latest.id}','${s.key}','approved','${escapeJs(s.label)}',${isFinal})">Approve</button>
        <button class="btn btn-red btn-sm" onclick="openDecisionModal('${activeDocId}','${latest.id}','${s.key}','rejected','${escapeJs(s.label)}',${isFinal})">Reject</button>
      </div>` : '';
    return `<div class="step-row ${rowCls}">
      <div class="step-status-ic">${icon}</div>
      <div class="step-row-body"><div class="t">${escapeHtml(s.label)}</div>${extra}${actions}</div>
    </div>`;
  }).join('');

  let stamp = '';
  if(latest.status === 'published') stamp = `<div class="stamp stamp-teal">Published<small>Signed by ${escapeHtml(latest.signedBy||'')} &middot; ${timeAgo(latest.signedAt)}</small></div>`;
  else if(latest.status === 'rejected') stamp = `<div class="stamp stamp-red">Rejected</div>`;

  const historyHtml = history.map(h => `
    <div class="hist-item"><div class="hdot"></div>
      <div><div>${escapeHtml(h.actorName)} &mdash; ${humanizeAction(h.action)}</div>
      <div class="htime">${fmtDate(h.timestamp)}</div>
      ${h.remarks ? `<div class="remarks">${escapeHtml(h.remarks)}</div>` : ''}</div>
    </div>`).join('') || '<div style="font-size:12.5px; color:var(--text-muted);">No history yet.</div>';

  const versionsHtml = versions.map(v => `
    <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px dashed var(--border); font-size:12.5px;">
      <span>v${v.versionNo} <span class="drawing-code" style="margin-left:6px;">${escapeHtml(v.revision||'')}</span>${v.supersededBy ? ' <span style="color:var(--text-muted);">(superseded)</span>' : ''}</span>
      <a href="${v.fileURL}" target="_blank" rel="noopener" style="color:var(--teal); font-weight:600; text-decoration:none;">Open file &#8599;</a>
    </div>`).join('');

  document.getElementById('detailBody').innerHTML = `
    <div class="detail-meta-grid">
      <div><span>Folder</span>${escapeHtml(typeof folderPath === 'function' ? folderPath(docData.folderId) : '—')}</div>
      <div><span>Project</span>${escapeHtml(docData.project)}</div>
      <div><span>Department</span>${escapeHtml(docData.department)}</div>
      <div><span>Category</span>${escapeHtml(docData.category)}</div>
      <div><span>Current Revision</span>${escapeHtml(latest.revision)}</div>
      <div><span>File</span><a href="${escapeHtml(latest.fileURL||'#')}" target="_blank" rel="noopener" style="color:var(--teal); font-weight:600; text-decoration:none;">${escapeHtml(latest.fileName||'Open')} &#8599;</a></div>
      <div><span>Uploaded By</span>${escapeHtml(latest.uploadedByName)}</div>
      <div><span>Status</span><span class="badge st-${latest.status}"><span class="dot"></span>${STATUS_LABELS[latest.status]}</span></div>
    </div>
    ${stamp}
    <h4 style="font-size:12px; margin:18px 0 4px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em;">Approval Progress</h4>
    <div class="stage-track">${stageNodes}</div>
    <div class="card" style="margin-bottom:18px;"><div class="panel" style="padding:6px 18px;">${stepRows}</div></div>
    ${canResubmit ? `<button class="btn btn-gold" onclick="openResubmitModal('${activeDocId}')" style="margin-bottom:18px;">Submit Revised Version</button>` : ''}
    <details style="margin-bottom:14px;"><summary style="cursor:pointer; font-weight:600; font-size:13px; color:var(--navy);">Version history (${versions.length})</summary><div style="margin-top:8px;">${versionsHtml}</div></details>
    <details open><summary style="cursor:pointer; font-weight:600; font-size:13px; color:var(--navy);">Audit history</summary><div style="margin-top:8px;">${historyHtml}</div></details>
  `;
}

/* ============================================================
   APPROVE / REJECT DECISION MODAL
============================================================ */
let pendingDecision = null;
function openDecisionModal(docId, versionId, stepKey, decision, stepLabel, isFinal){
  pendingDecision = { docId, versionId, stepKey, decision };

  document.getElementById('decisionTitle').textContent = (decision === 'approved' ? 'Approve — ' : 'Reject — ') + stepLabel;
  document.getElementById('decisionDesc').textContent = decision === 'approved'
    ? 'Confirm your decision for this step.'
    : 'Explain why this document is being rejected — the uploader will see this and be notified.';
  document.getElementById('remarksLabel').textContent = decision === 'rejected' ? 'Reason for rejection (required)' : 'Remarks (optional)';
  document.getElementById('decisionRemarks').value = '';

  const sigField = document.getElementById('signatureField');
  if(decision === 'approved' && isFinal){
    sigField.classList.remove('hidden');
    document.getElementById('signatureInput').value = '';
  } else {
    sigField.classList.add('hidden');
  }

  const btn = document.getElementById('decisionConfirmBtn');
  btn.className = 'btn ' + (decision === 'approved' ? 'btn-teal' : 'btn-red');
  btn.textContent = decision === 'approved' ? (isFinal ? 'Approve & Publish' : 'Approve') : 'Reject';
  btn.dataset.isFinal = isFinal ? '1' : '';
  btn.onclick = confirmDecision;
  openModal('decisionModalOverlay');
}

function confirmDecision(){
  const remarks = document.getElementById('decisionRemarks').value.trim();
  const { docId, versionId, stepKey, decision } = pendingDecision;
  const isFinal = document.getElementById('decisionConfirmBtn').dataset.isFinal === '1';

  if(decision === 'rejected' && !remarks){ toast('Please provide a reason for rejection.', 'err'); return; }
  let signature = null;
  if(decision === 'approved' && isFinal){
    signature = document.getElementById('signatureInput').value.trim();
    if(!signature){ toast('Please type your name to digitally sign.', 'err'); return; }
  }
  closeModal('decisionModalOverlay');
  applyStepDecision(docId, versionId, stepKey, decision, remarks, signature);
}

function applyStepDecision(docId, versionId, stepKey, decision, remarks, signature){
  const versionRef = db.collection('documents').doc(docId).collection('versions').doc(versionId);
  const docRef = db.collection('documents').doc(docId);

  db.runTransaction(tx => tx.get(versionRef).then(vSnap => {
    if(!vSnap.exists) throw new Error('Version not found.');
    const v = vSnap.data();
    if(v.status === 'rejected' || v.status === 'published') throw new Error('This document is no longer actionable.');
    const steps = v.steps.map(s => ({ ...s }));
    const idx = steps.findIndex(s => s.key === stepKey);
    if(idx === -1) throw new Error('Step not found.');
    const step = steps[idx];
    if(step.decision !== 'pending' || step.stage !== v.currentStage) throw new Error('This step is no longer actionable.');

    // Finality is determined from THIS document's own frozen steps, not the
    // live global workflow config — if an admin has since reconfigured the
    // workflow (added/removed stages), documents already in flight must
    // keep behaving exactly as they did when they were uploaded.
    const maxStageForThisDoc = Math.max(...steps.map(s => s.stage));

    const ts = firebase.firestore.Timestamp.now();
    step.decision = decision;
    step.decidedBy = currentUser.uid;
    step.decidedByName = currentUser.name;
    step.decidedAt = ts;
    step.remarks = remarks || null;

    let newStatus = v.status, newStage = v.currentStage, published = false;
    if(decision === 'rejected'){
      newStatus = 'rejected';
    } else {
      const stageSteps = steps.filter(s => s.stage === v.currentStage);
      if(stageSteps.every(s => s.decision === 'approved')){
        newStage = v.currentStage + 1;
        if(newStage > maxStageForThisDoc){ newStatus = 'published'; published = true; }
        else newStatus = 'pending_approval';
      }
    }

    const updates = { steps, status: newStatus, currentStage: newStage };
    if(published){ updates.signedBy = signature; updates.signedAt = ts; }
    tx.update(versionRef, updates);
    tx.update(docRef, { status: newStatus, updatedAt: ts });
    tx.set(versionRef.collection('history').doc(), {
      action: decision === 'approved' ? 'step_approved' : 'step_rejected',
      actor: currentUser.uid, actorName: currentUser.name, timestamp: ts,
      remarks: remarks || null, toStatus: newStatus
    });
    return { newStatus, newStage, published, steps, docTitle: v.docTitle, docDrawingNumber: v.docDrawingNumber, uploadedBy: v.uploadedBy, decision };
  })).then(result => {
    if(result.decision === 'rejected'){
      const msgR = `${result.docDrawingNumber} — ${result.docTitle} was rejected. See remarks and resubmit.`;
      notifyUser(result.uploadedBy, msgR, docId);
      if(typeof queueEmail === 'function') queueEmail('rejected', { uids: [result.uploadedBy] }, msgR, docId);
      toast('Document rejected. The uploader has been notified.', 'ok');
    } else if(result.published){
      const msgP = `${result.docDrawingNumber} — ${result.docTitle} has been approved and published.`;
      notifyUser(result.uploadedBy, msgP, docId);
      if(typeof queueEmail === 'function') queueEmail('published', { uids: [result.uploadedBy] }, msgP, docId);
      toast('Approved, signed, and published.', 'ok');
    } else if(result.newStatus === 'pending_approval'){
      notifyTask(result.steps.filter(s => s.stage === result.newStage), `${result.docDrawingNumber} — ${result.docTitle} is ready for your approval.`, docId);
      toast('Step approved — document advanced to the next stage.', 'ok');
    } else {
      toast('Step approved. Waiting on the parallel reviewer.', 'ok');
    }
    if(activeDocId === docId && document.getElementById('detailModalOverlay').classList.contains('active')) openDocumentDetail(docId);
  }).catch(err => toast(err.message, 'err'));
}

/* ============================================================
   RESUBMIT REVISED VERSION
============================================================ */
let resubFile = null;
const resubDropzone = document.getElementById('resubDropzone');
const resubFileInput = document.getElementById('resubFileInput');
resubDropzone.addEventListener('dragover', e => { e.preventDefault(); resubDropzone.classList.add('drag'); });
resubDropzone.addEventListener('dragleave', () => resubDropzone.classList.remove('drag'));
resubDropzone.addEventListener('drop', e => {
  e.preventDefault(); resubDropzone.classList.remove('drag');
  if(e.dataTransfer.files[0]) setResubFile(e.dataTransfer.files[0]);
});
resubFileInput.addEventListener('change', e => { if(e.target.files[0]) setResubFile(e.target.files[0]); });
function setResubFile(file){
  resubFile = file;
  document.getElementById('resubDzText').classList.add('hidden');
  document.getElementById('resubFilePillWrap').innerHTML = `<div class="filepill">&#128206; ${escapeHtml(file.name)}</div>`;
}
function openResubmitModal(docId){
  activeDocId = docId; resubFile = null;
  document.getElementById('resubDzText').classList.remove('hidden');
  document.getElementById('resubFilePillWrap').innerHTML = '';
  document.getElementById('resubRevision').value = '';
  document.getElementById('resubProgressWrap').style.display = 'none';
  document.getElementById('resubProgressBar').style.width = '0%';
  openModal('resubmitModalOverlay');
}
function submitResubmission(){
  if(!resubFile){ toast('Please choose a file.', 'err'); return; }
  const fileIssue = typeof validateUploadFile === 'function' ? validateUploadFile(resubFile) : null;
  if(fileIssue){ toast(fileIssue, 'err'); return; }
  const revision = document.getElementById('resubRevision').value.trim();
  if(!revision){ toast('Please enter a revision label.', 'err'); return; }

  const docRef = db.collection('documents').doc(activeDocId);
  const btn = document.getElementById('resubmitConfirmBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';

  docRef.get().then(docSnap => {
    const docData = docSnap.data();
    const resolved = typeof resolveWorkflowForUpload === 'function'
      ? resolveWorkflowForUpload(docData.folderId, docData.category)
      : resolveWorkflowForCategory(docData.category);
    if(!resolved){
      toast(typeof getUploadWorkflowIssue === 'function' ? getUploadWorkflowIssue(docData.folderId, docData.category) : getWorkflowResolutionIssue(docData.category), 'err');
      btn.disabled = false; btn.textContent = 'Submit Revised Version';
      return;
    }
    return docRef.collection('versions').orderBy('versionNo','desc').limit(1).get().then(vs => {
      const oldVersionDoc = vs.docs[0];
      const newVersionNo = (oldVersionDoc.data().versionNo || 1) + 1;
      const newVersionRef = docRef.collection('versions').doc();
      const storagePath = `documents/${activeDocId}/${newVersionRef.id}/${resubFile.name}`;
      const task = storage.ref(storagePath).put(resubFile);
      document.getElementById('resubProgressWrap').style.display = 'block';

      task.on('state_changed',
        snap => { document.getElementById('resubProgressBar').style.width = ((snap.bytesTransferred/snap.totalBytes)*100) + '%'; },
        err => { toast('Upload failed: ' + err.message, 'err'); btn.disabled = false; btn.textContent = 'Submit Revised Version'; },
        () => task.snapshot.ref.getDownloadURL().then(url => {
          const ts = firebase.firestore.Timestamp.now();
          const versionData = {
            versionNo: newVersionNo, revision, fileName: resubFile.name, fileURL: url, filePath: storagePath,
            uploadedBy: currentUser.uid, uploadedByName: currentUser.name, uploadedAt: ts,
            status: resolved.initialStatus || 'pending_review', currentStage: 0, steps: freshSteps(resolved.steps),
            workflowConfigName: resolved.configName,
            signedBy: null, signedAt: null, supersededBy: null,
            docTitle: docData.title, docDrawingNumber: docData.drawingNumber, docProject: docData.project, docId: activeDocId,
            docFolderId: docData.folderId || null
          };
          const batch = db.batch();
          batch.set(newVersionRef, versionData);
          batch.update(oldVersionDoc.ref, { supersededBy: newVersionRef.id });
          batch.update(docRef, { currentVersionNo: newVersionNo, currentVersionId: newVersionRef.id, status: versionData.status,
            currentFileName: resubFile.name, currentFileURL: url, currentRevision: revision, updatedAt: ts });
          batch.set(newVersionRef.collection('history').doc(), {
            action: 'resubmitted', actor: currentUser.uid, actorName: currentUser.name, timestamp: ts, remarks: null, toStatus: versionData.status
          });
          batch.commit().then(() => {
            notifyTask(resolved.steps.filter(s => s.stage === 0), `${docData.drawingNumber} — ${docData.title} resubmitted (v${newVersionNo}) and needs review.`, activeDocId);
            toast('Revised version submitted for review.', 'ok');
            closeModal('resubmitModalOverlay');
            btn.disabled = false; btn.textContent = 'Submit Revised Version';
            openDocumentDetail(activeDocId);
          });
        })
      );
    });
  });
}

/* ============================================================
   MASTER DATA — Projects, Departments, Categories
   Public read (see firestore.rules) so the registration screen can show
   department options before anyone is signed in; admin-only write.
   Each entry can have sub-items nested under it (parentId), one level deep
   — e.g. a Category can have Document Types under it, a Project can have
   Sub-Projects/Towers. Only top-level entries feed the Upload form's
   dropdowns; sub-items are an organizational reference for now.
============================================================ */
const MASTER_TYPES = [
  { key: 'projectMasters',    label: 'Projects',    singular: 'project',    selects: ['fProject','filterProject'],
    hasSubItems: true, panelId: 'projectsMasterPanel',
    starter: ['MP Winter','MP Merlin','MP Golden Heights','MP Pace Petals','MP Eden'],
    // Each project (and sub-item) automatically gets a folder in Files — see syncProjectFolders() in app-files.js
    inUseMessage: 'This project is in use and cannot be deleted.',
    isInUse: item => allDocsSnapshot.some(d => d.project === item.name) },
  { key: 'departmentMasters', label: 'Departments', singular: 'department', selects: ['fDepartment','newUserDept','filterDepartment','createRoleDeptSelect','editUserDept'],
    hasSubItems: true, panelId: 'departmentsMasterPanel',
    starter: ['Engineering','Architecture','Planning','QA/QC','Project Management','Management'],
    inUseMessage: 'This department is in use and cannot be deleted.',
    isInUse: item => allDocsSnapshot.some(d => d.department === item.name) || usersData.some(u => u.department === item.name) },
  { key: 'categoryMasters',   label: 'Document Categories',  singular: 'document category',   selects: ['fCategory','filterCategory'],
    hasSubItems: true, panelId: 'categoriesMasterPanel',
    starter: ['Structural Drawings','Architectural Drawings','MEP Drawings','Electrical Drawings','HVAC','Landscape','Legal Documents','BOQ','Quality Documents'],
    inUseMessage: 'This document category is already in use and cannot be deleted.',
    isInUse: item => allDocsSnapshot.some(d => d.category === item.name) }
];
let mastersData = { projectMasters: [], departmentMasters: [], categoryMasters: [] };
let expandedMasterItems = { projectMasters: new Set(), departmentMasters: new Set(), categoryMasters: new Set() };
let editingMasterItem = null; // { typeKey, id }

function listenMasters(){
  MASTER_TYPES.forEach(mt => {
    const unsub = db.collection(mt.key).orderBy('name').onSnapshot(snap => {
      mastersData[mt.key] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const topLevel = mastersData[mt.key].filter(it => !it.parentId);
      mt.selects.forEach(selId => populateSelect(selId, topLevel));
      refreshMasterDataPanels();
      if(mt.key === 'categoryMasters' && currentUser && currentUser.role === 'admin') renderWorkflowConfigView();
      if(mt.key === 'projectMasters' && typeof onProjectMastersChanged === 'function') onProjectMastersChanged();
    }, err => console.error(mt.key + ' listener:', err));
    // Only track for teardown when running post-login (masters also load
    // pre-login for the old registration screen's use case — harmless to
    // leave that particular use unsubscribed, it's a one-time public read).
    if(currentUser) activeSessionUnsubs.push(unsub);
  });
}

// Re-renders whichever master-data admin panels are currently relevant.
// Called whenever the underlying master lists, documents, or users change,
// since "is this entry in use" depends on documents/users data too.
function refreshMasterDataPanels(){
  if(!(currentUser && currentUser.role === 'admin')) return;
  MASTER_TYPES.forEach(mt => renderSingleMasterPanel(mt));
}

function populateSelect(selectId, items){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  const prevValue = sel.value;
  const placeholder = sel.options[0] && sel.options[0].value === '' ? sel.options[0].outerHTML : '';
  sel.innerHTML = placeholder + items.map(it => `<option>${escapeHtml(it.name)}</option>`).join('');
  if(items.some(it => it.name === prevValue)) sel.value = prevValue;
}

function renderSingleMasterPanel(mt){
  const panel = document.getElementById(mt.panelId);
  if(!panel) return;
  const all = mastersData[mt.key];
  const topLevel = all.filter(it => !it.parentId);
  const listHtml = topLevel.length
    ? topLevel.map(it => renderMasterItemRow(mt, it, all)).join('')
    : `<div class="master-empty">No entries yet.<br><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="seedMasterDefaults('${mt.key}')">Load starter list (${mt.starter.length})</button></div>`;
  panel.innerHTML = `<div class="master-list">${listHtml}</div>`;
}

function renderMasterItemRow(mt, item, all){
  const inUse = mt.isInUse(item);
  const isEditing = editingMasterItem && editingMasterItem.typeKey === mt.key && editingMasterItem.id === item.id;

  let mainRow;
  if(isEditing){
    mainRow = `<div class="master-item master-item-editing">
      <input type="text" id="editinput_${mt.key}_${item.id}" value="${escapeHtml(item.name)}"
        onkeydown="if(event.key==='Enter'){event.preventDefault(); saveMasterEdit('${mt.key}','${item.id}');} if(event.key==='Escape'){cancelMasterEdit();}">
      <button class="btn btn-teal btn-sm" onclick="saveMasterEdit('${mt.key}','${item.id}')">Save</button>
      <button class="btn btn-ghost btn-sm" onclick="cancelMasterEdit()">Cancel</button>
    </div>`;
  } else {
    const children = all.filter(it => it.parentId === item.id);
    const isOpen = expandedMasterItems[mt.key].has(item.id);
    const chevron = isOpen ? '&#9662;' : '&#9656;';
    mainRow = `<div class="master-item">
      <span onclick="${mt.hasSubItems ? `toggleMasterExpand('${mt.key}','${item.id}')` : ''}" style="cursor:${mt.hasSubItems?'pointer':'default'}; display:flex; align-items:center; gap:6px; flex:1;">
        ${mt.hasSubItems ? `<span class="master-chevron">${chevron}</span>` : ''}${escapeHtml(item.name)}${children.length ? `<span class="master-subcount">${children.length}</span>` : ''}${inUse ? '<span class="master-inuse-tag">In use</span>' : ''}
      </span>
      <div class="master-row-actions">
        <button class="icon-btn-sm" onclick="startMasterEdit('${mt.key}','${item.id}')" title="${inUse?'In use — rename disabled':'Edit'}" ${inUse?'disabled':''}>&#9999;&#65039;</button>
        <button class="icon-btn-sm" onclick="removeMasterEntry('${mt.key}','${item.id}')" title="${inUse?'In use — delete disabled':'Delete'}" ${inUse?'disabled':''}>&#128465;&#65039;</button>
      </div>
    </div>`;
    if(mt.hasSubItems && isOpen){
      const childrenHtml = `
        <div class="master-sublist">
          ${children.map(c => renderMasterItemRow(mt, c, all)).join('')}
          <div class="master-add-row master-sub-add-row">
            <input type="text" id="newsub_${mt.key}_${item.id}" placeholder="Add sub-item&hellip;" onkeydown="if(event.key==='Enter'){event.preventDefault(); addSubMasterEntry('${mt.key}','${item.id}');}">
            <button class="btn btn-ghost btn-sm" onclick="addSubMasterEntry('${mt.key}','${item.id}')">Add</button>
          </div>
        </div>`;
      return `<div class="master-item-wrap">${mainRow}${childrenHtml}</div>`;
    }
  }
  return `<div class="master-item-wrap">${mainRow}</div>`;
}

function toggleMasterExpand(typeKey, itemId){
  const set = expandedMasterItems[typeKey];
  if(set.has(itemId)) set.delete(itemId); else set.add(itemId);
  refreshMasterDataPanels();
}

function startMasterEdit(typeKey, id){
  const mt = MASTER_TYPES.find(m => m.key === typeKey);
  const item = mastersData[typeKey].find(it => it.id === id);
  if(item && mt.isInUse(item)){ toast("This entry is in use and can't be renamed — documents that reference it store the name directly.", 'err'); return; }
  editingMasterItem = { typeKey, id };
  refreshMasterDataPanels();
  setTimeout(() => { const el = document.getElementById(`editinput_${typeKey}_${id}`); if(el){ el.focus(); el.select(); } }, 0);
}
function cancelMasterEdit(){
  editingMasterItem = null;
  refreshMasterDataPanels();
}
function saveMasterEdit(typeKey, id){
  const input = document.getElementById(`editinput_${typeKey}_${id}`);
  const name = input.value.trim();
  if(!name){ toast('Name cannot be empty.', 'err'); return; }
  const current = mastersData[typeKey].find(it => it.id === id);
  const parentId = current ? (current.parentId || null) : null;
  const dup = mastersData[typeKey].some(it => it.id !== id && (it.parentId || null) === parentId && it.name.toLowerCase() === name.toLowerCase());
  if(dup){ toast('That name already exists.', 'err'); return; }
  db.collection(typeKey).doc(id).update({ name })
    .then(() => { editingMasterItem = null; toast('Saved.', 'ok'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}

let createMasterModalType = null;
function openCreateMasterModal(typeKey){
  createMasterModalType = typeKey;
  const mt = MASTER_TYPES.find(m => m.key === typeKey);
  const singularCap = mt.singular.charAt(0).toUpperCase() + mt.singular.slice(1);
  document.getElementById('createMasterModalTitle').textContent = 'Create ' + singularCap;
  document.getElementById('createMasterModalLabel').textContent = singularCap + ' name';
  const input = document.getElementById('createMasterModalInput');
  input.value = '';
  input.placeholder = `e.g. ${mt.starter[0]}`;
  document.getElementById('createMasterModalConfirmBtn').textContent = 'Create ' + singularCap;
  openModal('createMasterModalOverlay');
  setTimeout(() => input.focus(), 0);
}
function submitCreateMasterModal(){
  const typeKey = createMasterModalType;
  const name = document.getElementById('createMasterModalInput').value.trim();
  if(!name){ toast('Please enter a name.', 'err'); return; }
  const existing = mastersData[typeKey].some(it => !it.parentId && it.name.toLowerCase() === name.toLowerCase());
  if(existing){ toast('That entry already exists.', 'err'); return; }
  db.collection(typeKey).add({ name, parentId: null, createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => { toast('Created.', 'ok'); closeModal('createMasterModalOverlay'); })
    .catch(err => toast('Could not create: ' + err.message, 'err'));
}
function addSubMasterEntry(typeKey, parentId){
  const input = document.getElementById(`newsub_${typeKey}_${parentId}`);
  const name = input.value.trim();
  if(!name) return;
  const existing = mastersData[typeKey].some(it => it.parentId === parentId && it.name.toLowerCase() === name.toLowerCase());
  if(existing){ toast('That sub-item already exists.', 'err'); return; }
  db.collection(typeKey).add({ name, parentId, createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => { input.value = ''; toast('Added.', 'ok'); })
    .catch(err => toast('Could not add: ' + err.message, 'err'));
}
function removeMasterEntry(typeKey, id){
  const mt = MASTER_TYPES.find(m => m.key === typeKey);
  const item = mastersData[typeKey].find(it => it.id === id);
  if(!item) return;
  if(mt.isInUse(item)){ toast(mt.inUseMessage, 'err'); return; }
  if(!confirm(`Are you sure you want to delete this ${mt.singular}?\n\n"${item.name}"`)) return;
  // Cascade — remove any sub-items nested under this one too, so nothing
  // gets orphaned and invisible. (Sub-items aren't currently referenced by
  // any document, so no usage-check is needed for them specifically.)
  const children = mastersData[typeKey].filter(it => it.parentId === id);
  const batch = db.batch();
  batch.delete(db.collection(typeKey).doc(id));
  children.forEach(c => batch.delete(db.collection(typeKey).doc(c.id)));
  batch.commit()
    .then(() => toast(children.length ? `Removed (and ${children.length} sub-item${children.length > 1 ? 's' : ''}).` : 'Removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}
function seedMasterDefaults(typeKey){
  const mt = MASTER_TYPES.find(m => m.key === typeKey);
  const batch = db.batch();
  mt.starter.forEach(name => {
    batch.set(db.collection(typeKey).doc(), { name, parentId: null, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  });
  batch.commit()
    .then(() => toast(`Loaded starter ${mt.label.toLowerCase()} list.`, 'ok'))
    .catch(err => toast('Could not seed: ' + err.message, 'err'));
}

/* ============================================================
   ROLES (admin edits; live for everyone)
   Unlike Projects/Departments/Categories, users and workflow steps store
   the role's FIRESTORE ID (not its name) — so renaming a role is always
   safe, even while in use; only DELETING an in-use role is blocked.
   "Admin" is a hardcoded, built-in role (the security rules key off the
   literal string 'admin' directly) and isn't stored in this collection —
   it's shown as a protected, non-editable entry at the top of the list.
============================================================ */
let roleMastersData = [];
let editingRoleId = null;
let customStatusesData = [];
let editingCustomStatusId = null;

function listenRoleMasters(){
  const unsub = db.collection('roleMasters').orderBy('name').onSnapshot(snap => {
    roleMastersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    ROLE_LABELS = { admin: 'Admin' };
    roleMastersData.forEach(r => { ROLE_LABELS[r.id] = r.name; });
    populateRoleSelects();
    if(currentUser && currentUser.role === 'admin'){
      renderRolesMasterView();
      renderWorkflowConfigView(); // its role picker reflects ROLE_LABELS too
    }
  }, err => console.error('role masters listener:', err));
  activeSessionUnsubs.push(unsub);
}

function populateRoleSelects(){
  const optionsHtml = '<option value="">Select role&hellip;</option>' +
    Object.entries(ROLE_LABELS).map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  ['newUserRole', 'editUserRole'].forEach(selId => {
    const sel = document.getElementById(selId);
    if(!sel) return;
    const prevValue = sel.value;
    sel.innerHTML = optionsHtml;
    if(ROLE_LABELS[prevValue]) sel.value = prevValue;
  });
  [['newUserRolesAvailable','newUserRolesSelected'], ['editUserRolesAvailable','editUserRolesSelected']].forEach(([availId, selId]) => {
    const selEl = document.getElementById(selId);
    if(!selEl) return;
    const currentlySelected = Array.from(selEl.options).map(o => o.value);
    populateRoleDualListbox(availId, selId, currentlySelected);
  });
}

// Fills the two sides of a dual-listbox role picker: "Selected" gets the
// given role IDs, "Available" gets every other non-admin role. Admin is
// deliberately excluded from both sides — it's never an "additional" role,
// it's the separate, untouched primary-role admin flag.
function populateRoleDualListbox(availId, selId, selectedRoleIds){
  const availEl = document.getElementById(availId);
  const selEl = document.getElementById(selId);
  if(!availEl || !selEl) return;
  const selected = new Set((selectedRoleIds || []).filter(id => id && id !== 'admin'));
  availEl.innerHTML = Object.entries(ROLE_LABELS)
    .filter(([id]) => id !== 'admin' && !selected.has(id))
    .map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  selEl.innerHTML = [...selected]
    .map(id => `<option value="${id}">${escapeHtml(ROLE_LABELS[id] || id)}</option>`).join('');
}
// Moves every currently-highlighted <option> from one <select multiple>
// to another — the standard vanilla-JS dual-listbox pattern.
function moveDualListbox(fromId, toId){
  const from = document.getElementById(fromId);
  const to = document.getElementById(toId);
  if(!from || !to) return;
  Array.from(from.selectedOptions).forEach(opt => to.appendChild(opt));
}

function isRoleInUse(roleId){
  return usersData.some(u => getUserRoles(u).includes(roleId)) || workflowConfigStepsData.some(s => s.role === roleId);
}

function renderRolesMasterView(){
  const panel = document.getElementById('rolesMasterPanel');
  if(!panel) return;
  const adminRow = `<div class="master-item-wrap"><div class="master-item">
      <span style="display:flex; align-items:center; gap:6px; flex:1;">Admin <span class="master-builtin-tag">Built-in</span></span>
      <div class="master-row-actions">
        <button class="icon-btn-sm" disabled title="Built-in — can't be edited">&#9999;&#65039;</button>
        <button class="icon-btn-sm" disabled title="Built-in — can't be deleted">&#128465;&#65039;</button>
      </div>
    </div></div>`;
  const customRows = roleMastersData.map(r => renderRoleRow(r)).join('');
  const emptyHint = roleMastersData.length === 0
    ? `<div class="master-empty">No custom roles yet.<br><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="seedDefaultRoles()">Load starter roles (${Object.keys(DEFAULT_ROLES).length})</button></div>`
    : '';
  panel.innerHTML = `<div class="master-list">${adminRow}${customRows}${emptyHint}</div>`;
}

function renderRoleRow(r){
  const inUse = isRoleInUse(r.id);
  const isEditing = editingRoleId === r.id;
  if(isEditing){
    return `<div class="master-item-wrap"><div class="master-item master-item-editing">
      <input type="text" id="editrole_${r.id}" value="${escapeHtml(r.name)}"
        onkeydown="if(event.key==='Enter'){event.preventDefault(); saveRoleEdit('${r.id}');} if(event.key==='Escape'){cancelRoleEdit();}">
      <button class="btn btn-teal btn-sm" onclick="saveRoleEdit('${r.id}')">Save</button>
      <button class="btn btn-ghost btn-sm" onclick="cancelRoleEdit()">Cancel</button>
    </div></div>`;
  }
  return `<div class="master-item-wrap"><div class="master-item">
    <span style="flex:1;">${escapeHtml(r.name)}${r.department ? `<span style="color:var(--text-muted); font-weight:400; font-size:12px;"> &middot; ${escapeHtml(r.department)}</span>` : ''}${inUse ? '<span class="master-inuse-tag">In use</span>' : ''}</span>
    <div class="master-row-actions">
      <button class="icon-btn-sm" onclick="startRoleEdit('${r.id}')" title="Edit">&#9999;&#65039;</button>
      <button class="icon-btn-sm" onclick="removeRole('${r.id}')" title="${inUse?'In use — delete disabled':'Delete'}" ${inUse?'disabled':''}>&#128465;&#65039;</button>
    </div>
  </div></div>`;
}

function startRoleEdit(id){
  editingRoleId = id;
  renderRolesMasterView();
  setTimeout(() => { const el = document.getElementById('editrole_' + id); if(el){ el.focus(); el.select(); } }, 0);
}
function cancelRoleEdit(){
  editingRoleId = null;
  renderRolesMasterView();
}
function saveRoleEdit(id){
  const input = document.getElementById('editrole_' + id);
  const name = input.value.trim();
  if(!name){ toast('Name cannot be empty.', 'err'); return; }
  const dup = roleMastersData.some(r => r.id !== id && r.name.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === 'admin';
  if(dup){ toast('That role name is already in use.', 'err'); return; }
  db.collection('roleMasters').doc(id).update({ name })
    .then(() => { editingRoleId = null; toast('Saved.', 'ok'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function openCreateRoleModal(){
  document.getElementById('createRoleNameInput').value = '';
  document.getElementById('createRoleDeptSelect').value = '';
  openModal('createRoleModalOverlay');
  setTimeout(() => document.getElementById('createRoleNameInput').focus(), 0);
}
function submitCreateRole(){
  const name = document.getElementById('createRoleNameInput').value.trim();
  const department = document.getElementById('createRoleDeptSelect').value;
  if(!name){ toast('Please enter a role name.', 'err'); return; }
  const dup = roleMastersData.some(r => r.name.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === 'admin';
  if(dup){ toast('That role already exists.', 'err'); return; }
  db.collection('roleMasters').add({ name, department: department || '', createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => { toast('Role created.', 'ok'); closeModal('createRoleModalOverlay'); })
    .catch(err => toast('Could not create: ' + err.message, 'err'));
}
function removeRole(id){
  const role = roleMastersData.find(r => r.id === id);
  if(!role) return;
  if(isRoleInUse(id)){ toast('This role is assigned to one or more users and cannot be deleted.', 'err'); return; }
  if(!confirm(`Are you sure you want to delete this role?\n\n"${role.name}"`)) return;
  db.collection('roleMasters').doc(id).delete()
    .then(() => toast('Role removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}
function seedDefaultRoles(){
  const batch = db.batch();
  Object.entries(DEFAULT_ROLES).forEach(([id, name]) => {
    batch.set(db.collection('roleMasters').doc(id), { name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  });
  batch.commit()
    .then(() => toast('Starter roles loaded.', 'ok'))
    .catch(err => toast('Could not seed: ' + err.message, 'err'));
}

/* ============================================================
   WORKFLOW CONFIGURATIONS (admin edits; live for everyone)
   Each Document Category gets its own workflow automatically — no
   separate "create a workflow" step. The list page shows one row per
   Document Category (from Masters &rarr; Document Category Master) plus a Default row
   for any category without its own steps; clicking a row opens that
   category's Role/From-To Status mapping table directly. Steps are keyed
   by `category` (an empty string means the Default workflow).
   computeStatusChain() walks the sequence automatically by matching each
   step's toStatus to the next step's fromStatus (steps sharing a
   fromStatus run in parallel); resolveWorkflowForCategory() turns that
   into the internal stage-group numbers the approval engine has always
   used, and documents freeze a copy of the result at upload time — later
   edits here never retroactively affect documents already in progress.
============================================================ */
let workflowConfigStepsData = [];    // [{id, category, role, fromStatus, toStatus, label}]
let activeWorkflowCategory = null;   // category string ('' = Default) whose detail view is open; undefined/null = list view

function listenWorkflowConfigs(){
  const unsub = db.collection('workflowConfigSteps').onSnapshot(snap => {
    workflowConfigStepsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if(currentUser && currentUser.role === 'admin') renderWorkflowConfigView();
    updateUploadWorkflowHint();
  }, err => console.error('workflowConfigSteps listener:', err));
  activeSessionUnsubs.push(unsub);
}

// Walks a set of {fromStatus, toStatus} mappings purely by matching each
// step's toStatus to the next step's fromStatus — no manual ordering at
// all. Steps sharing the same fromStatus run in parallel (all must
// approve before the chain advances); the walk starts at whichever status
// isn't produced by any step here (nothing transitions INTO it) and ends
// when a status is reached that no step starts from. Returns an error
// instead of a result if the chain is ambiguous, cyclic, or disconnected,
// so problems surface as a clear message rather than silently misbehaving.
function computeStatusChain(steps){
  if(steps.length === 0) return { ok: true, staged: [] };
  const fromSet = new Set(steps.map(s => s.fromStatus));
  const toSet = new Set(steps.map(s => s.toStatus));
  const roots = [...fromSet].filter(fs => !toSet.has(fs));

  if(roots.length === 0){
    return { ok: false, error: 'Could not find a starting point — every status here is also produced by another step (a loop).' };
  }
  if(roots.length > 1){
    const labels = getAllStatusOptions();
    return { ok: false, error: `Found more than one possible starting point (${roots.map(r => labels[r] || r).join(', ')}) — every step should chain from a single starting status.` };
  }

  const staged = [];
  const seen = new Set();
  let current = roots[0];
  let stage = 0;
  while(true){
    if(seen.has(current)){
      return { ok: false, error: 'This workflow loops back on itself (a status eventually leads back to one already used) — check the From/To Status chain.' };
    }
    seen.add(current);
    const here = steps.filter(s => s.fromStatus === current);
    if(here.length === 0) break;
    const nextSet = new Set(here.map(s => s.toStatus));
    if(nextSet.size > 1){
      const labels = getAllStatusOptions();
      return { ok: false, error: `Steps starting from "${labels[current] || current}" lead to different next statuses (${[...nextSet].map(s => labels[s] || s).join(', ')}) — parallel steps at the same point must all lead to the same next status.` };
    }
    here.forEach(s => staged.push({ ...s, stage }));
    current = [...nextSet][0];
    stage++;
    if(stage > 50) return { ok: false, error: 'This chain is unexpectedly long — something is likely misconfigured.' };
  }
  if(staged.length < steps.length){
    return { ok: false, error: "Some steps aren't connected to the main chain — check that each step's From Status matches another step's To Status (or is the starting status)." };
  }
  return { ok: true, staged };
}

function resolveWorkflowForCategory(category){
  let raw = workflowConfigStepsData.filter(s => s.category === category);
  let usedCategory = category;
  if(raw.length === 0){
    raw = workflowConfigStepsData.filter(s => s.category === '');
    usedCategory = '';
  }
  if(raw.length === 0) return null;
  const result = computeStatusChain(raw);
  if(!result.ok) return null; // caller treats this the same as "no workflow" — blocks upload with a message
  return {
    configName: usedCategory === '' ? 'Default Workflow' : usedCategory,
    steps: result.staged.map(s => ({
      key: s.id, label: s.label || ROLE_LABELS[s.role] || s.role, role: s.role,
      stage: s.stage, fromStatus: s.fromStatus || '', toStatus: s.toStatus || ''
    }))
  };
}

// Same lookup as resolveWorkflowForCategory, but surfaces WHY it failed
// (no steps at all vs. a broken chain) — used for a specific, actionable
// message instead of a generic "not configured".
function getWorkflowResolutionIssue(category){
  let raw = workflowConfigStepsData.filter(s => s.category === category);
  let usedCategory = category;
  if(raw.length === 0){
    raw = workflowConfigStepsData.filter(s => s.category === '');
    usedCategory = '';
  }
  if(raw.length === 0) return 'No workflow is configured for this category (and no Default workflow exists).';
  const result = computeStatusChain(raw);
  if(result.ok) return null;
  const label = usedCategory === '' ? 'The Default workflow' : `"${usedCategory}"`;
  return `${label} has a configuration problem: ${result.error}`;
}

function updateUploadWorkflowHint(){
  const el = document.getElementById('uploadWorkflowHint');
  if(!el) return;
  const category = document.getElementById('fCategory') ? document.getElementById('fCategory').value : '';
  const folderId = document.getElementById('fFolder') ? document.getElementById('fFolder').value : '';
  const byFolder = folderId && typeof resolveWorkflowForFolder === 'function' ? resolveWorkflowForFolder(folderId) : null;
  if(byFolder){
    const rv = byFolder.steps.filter(s => s.key.startsWith('rv_')).length, ap = byFolder.steps.filter(s => s.key.startsWith('ap_')).length;
    el.innerHTML = `Workflow: <b>${escapeHtml(byFolder.configName)}</b> &mdash; ${rv} reviewer(s) &rarr; ${ap} approver(s)`;
    return;
  }
  if(!category){ el.innerHTML = folderId ? 'This folder has no reviewers/approvers, so the Document Category workflow will be used.' : ''; return; }
  const resolved = resolveWorkflowForCategory(category);
  if(resolved){
    el.innerHTML = `Workflow: <b>${escapeHtml(resolved.configName)}</b> (${resolved.steps.length} step${resolved.steps.length === 1 ? '' : 's'})`;
  } else {
    el.innerHTML = `<span style="color:var(--red);">${escapeHtml(getWorkflowResolutionIssue(category))}</span>`;
  }
}

function renderWorkflowConfigView(){
  const panel = document.getElementById('workflowConfigPanel');
  if(!panel) return;
  if(activeWorkflowCategory !== null && activeWorkflowCategory !== undefined) renderWorkflowConfigDetail(panel);
  else renderWorkflowConfigList(panel);
}

function renderWorkflowConfigList(panel){
  const topLevelCategories = mastersData.categoryMasters.filter(it => !it.parentId);
  const rows = [{ category: '', displayName: 'Default', isDefault: true }, ...topLevelCategories.map(c => ({ category: c.name, displayName: c.name, isDefault: false }))]
    .map(row => {
      const stepCount = workflowConfigStepsData.filter(s => s.category === row.category).length;
      return `<tr onclick="openWorkflowConfigDetail('${escapeJs(row.category)}')">
        <td>${escapeHtml(row.displayName)}${row.isDefault ? ' <span style="color:var(--text-muted); font-weight:400;">(any category without its own workflow)</span>' : ''}</td>
        <td>${stepCount} step${stepCount === 1 ? '' : 's'}</td>
        <td style="text-align:right;"><button class="icon-btn-sm" onclick="event.stopPropagation(); openWorkflowConfigDetail('${escapeJs(row.category)}')" title="Configure">&#9999;&#65039;</button></td>
      </tr>`;
    }).join('');
  panel.innerHTML = `<table><thead><tr><th>Document Category</th><th>Steps</th><th></th></tr></thead><tbody>${rows}</tbody></table>
       <div class="auth-hint" style="margin-top:14px;">Categories come from <b>Masters &rarr; Document Category Master</b> — add one there and it shows up here automatically.</div>`;
}

function renderWorkflowConfigDetail(panel){
  const category = activeWorkflowCategory;
  const isDefault = category === '';
  const displayName = isDefault ? 'Default Workflow' : category;
  const allStatusOptions = getAllStatusOptions();
  const stepsRaw = workflowConfigStepsData.filter(s => s.category === category);
  const chainResult = computeStatusChain(stepsRaw);

  let tableOrWarning;
  if(stepsRaw.length === 0){
    tableOrWarning = `<div class="master-empty">No steps yet — add at least one below.</div>`;
  } else if(!chainResult.ok){
    tableOrWarning = `
      <div class="auth-error" style="display:block; margin-bottom:16px;">${escapeHtml(chainResult.error)} Uploads using this workflow are blocked until this is fixed.</div>
      <table><thead><tr><th>Role</th><th>From Status</th><th>To Status</th><th></th></tr></thead><tbody>
        ${stepsRaw.map(s => `<tr>
          <td>${escapeHtml(ROLE_LABELS[s.role] || s.role)}</td>
          <td>${escapeHtml(allStatusOptions[s.fromStatus] || s.fromStatus || '—')}</td>
          <td>${escapeHtml(allStatusOptions[s.toStatus] || s.toStatus || '—')}</td>
          <td style="text-align:right;"><button class="icon-btn-sm" onclick="removeWorkflowConfigStep('${s.id}')" title="Delete">&#128465;&#65039;</button></td>
        </tr>`).join('')}
      </tbody></table>`;
  } else {
    const rows = chainResult.staged.map(s => {
      const parallelCount = chainResult.staged.filter(x => x.stage === s.stage).length;
      const parallelBadge = parallelCount > 1 ? '<span class="step-chip approved" style="margin-left:8px;">&Vert; Parallel</span>' : '';
      return `<tr>
        <td><span class="drawing-code">${s.stage + 1}</span></td>
        <td>${escapeHtml(ROLE_LABELS[s.role] || s.role)}${parallelBadge}</td>
        <td>${escapeHtml(allStatusOptions[s.fromStatus] || s.fromStatus || '—')}</td>
        <td>${escapeHtml(allStatusOptions[s.toStatus] || s.toStatus || '—')}</td>
        <td style="text-align:right;"><button class="icon-btn-sm" onclick="removeWorkflowConfigStep('${s.id}')" title="Delete">&#128465;&#65039;</button></td>
      </tr>`;
    }).join('');
    tableOrWarning = `<table><thead><tr><th style="width:50px;">#</th><th>Role</th><th>From Status</th><th>To Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const statusOptionsHtml = Object.entries(allStatusOptions).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('');

  panel.innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="backToWorkflowList()" style="margin-bottom:16px;">&larr; Back to Workflows</button>
    <h3 style="margin-bottom:3px;">${escapeHtml(displayName)}</h3>
    <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:18px;">${isDefault ? 'Applies to any Document Category without its own steps below' : `Document Category: <b>${escapeHtml(category)}</b>`}</div>
    ${tableOrWarning}
    <div class="workflow-add-block" style="margin-top:20px; padding-top:18px; border-top:1px solid var(--border);">
      <h4>Add Workflow Mapping</h4>
      <div class="workflow-add-row">
        <select id="newStepRole">
          <option value="">Role&hellip;</option>
          ${Object.entries(ROLE_LABELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
        </select>
        <select id="newStepFromStatus"><option value="">From Status&hellip;</option>${statusOptionsHtml}</select>
        <select id="newStepToStatus"><option value="">To Status&hellip;</option>${statusOptionsHtml}</select>
        <button class="btn btn-teal btn-sm" onclick="addWorkflowConfigStep()">+ Add Mapping</button>
      </div>
      <div class="auth-hint" style="margin-top:10px;">No manual ordering needed — the sequence is worked out automatically by matching each step's To Status to the next step's From Status. Steps that share a From Status run in parallel. The "#" column shows the order this produced, purely for reference.</div>
    </div>
  `;
}

function openWorkflowConfigDetail(category){
  activeWorkflowCategory = category;
  renderWorkflowConfigView();
}
function backToWorkflowList(){
  activeWorkflowCategory = null;
  renderWorkflowConfigView();
}

function addWorkflowConfigStep(){
  const category = activeWorkflowCategory;
  const role = document.getElementById('newStepRole').value;
  const fromStatus = document.getElementById('newStepFromStatus').value;
  const toStatus = document.getElementById('newStepToStatus').value;
  if(!role){ toast('Please choose a role.', 'err'); return; }
  if(!fromStatus || !toStatus){ toast('Please choose both From Status and To Status.', 'err'); return; }
  if(fromStatus === toStatus){ toast('From Status and To Status can\'t be the same.', 'err'); return; }
  const existingSteps = workflowConfigStepsData.filter(s => s.category === category);
  const dup = existingSteps.some(s => s.role === role && s.fromStatus === fromStatus && s.toStatus === toStatus);
  if(dup){ toast('An identical mapping already exists in this workflow.', 'err'); return; }
  // Steps sharing a From Status run in parallel and must all lead to the
  // SAME To Status — otherwise the chain can't be walked unambiguously.
  const conflicting = existingSteps.find(s => s.fromStatus === fromStatus && s.toStatus !== toStatus);
  if(conflicting){
    const labels = getAllStatusOptions();
    toast(`Another step already goes from "${labels[fromStatus] || fromStatus}" to "${labels[conflicting.toStatus] || conflicting.toStatus}" — parallel steps at the same point must lead to the same next status.`, 'err');
    return;
  }
  const label = ROLE_LABELS[role] || role;
  db.collection('workflowConfigSteps').add({
    category, label, role, fromStatus, toStatus,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  })
    .then(() => toast('Mapping added.', 'ok'))
    .catch(err => toast('Could not add: ' + err.message, 'err'));
}
function removeWorkflowConfigStep(stepId){
  const step = workflowConfigStepsData.find(s => s.id === stepId);
  if(!step) return;
  const categorySteps = workflowConfigStepsData.filter(s => s.category === step.category);
  if(step.category === '' && categorySteps.length <= 1){
    toast('The Default workflow needs at least one step — categories without their own workflow rely on it. Add a replacement before removing the last one.', 'err');
    return;
  }
  if(!confirm(`Are you sure you want to remove this workflow mapping?\n\n"${ROLE_LABELS[step.role] || step.role}"`)) return;
  db.collection('workflowConfigSteps').doc(stepId).delete()
    .then(() => toast('Mapping removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}
function seedDefaultWorkflow(){
  const batch = db.batch();
  DEFAULT_WORKFLOW_STEPS.forEach(s => {
    batch.set(db.collection('workflowConfigSteps').doc(), {
      category: '', label: s.label, role: s.role,
      fromStatus: s.fromStatus, toStatus: s.toStatus,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
  batch.commit()
    .then(() => { toast('Starter workflow loaded.', 'ok'); openWorkflowConfigDetail(''); })
    .catch(err => toast('Could not seed: ' + err.message, 'err'));
}

/* ============================================================
   STATUS LABELS (admin edits; live for everyone)
   The underlying status keys are fixed (they're wired into the approval
   engine's logic) — this only lets an Admin rename how each one displays.
============================================================ */
function listenStatusLabels(){
  const unsub1 = db.collection('statusLabels').onSnapshot(snap => {
    const overrides = {};
    snap.docs.forEach(d => { overrides[d.id] = d.data().label; });
    STATUS_LABELS = { ...DEFAULT_STATUS_LABELS, ...overrides };
    populateStatusFilterOptions();
    if(currentUser && currentUser.role === 'admin') renderStatusConfigView();
    renderDocsTable();
    renderQueue();
  }, err => console.error('status labels listener:', err));
  const unsub2 = db.collection('customStatuses').orderBy('name').onSnapshot(snap => {
    customStatusesData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if(currentUser && currentUser.role === 'admin'){
      renderStatusConfigView();
      renderWorkflowConfigView(); // its From/To Status pickers include custom statuses too
    }
  }, err => console.error('custom statuses listener:', err));
  activeSessionUnsubs.push(unsub1, unsub2);
}

// Combines the 5 built-in (real, engine-driving) statuses with admin-created
// custom ones, for use ONLY in Workflow Configuration's From/To Status
// pickers — those fields are documentation/reference on each step, not the
// actual value stored in a document's own status field, so mixing in
// custom entries here is safe and doesn't touch the real state machine.
function getAllStatusOptions(){
  const combined = { ...STATUS_LABELS };
  customStatusesData.forEach(c => { combined[c.id] = c.name; });
  return combined;
}

function isCustomStatusInUse(statusId){
  return workflowConfigStepsData.some(s => s.fromStatus === statusId || s.toStatus === statusId);
}

function renderStatusConfigView(){
  const panel = document.getElementById('statusConfigPanel');
  if(!panel) return;
  const builtInRows = Object.keys(DEFAULT_STATUS_LABELS).map(key => `
    <div class="status-edit-row">
      <span class="status-key">${key} <span class="master-builtin-tag">Built-in</span></span>
      <input type="text" id="statuslabel_${key}" value="${escapeHtml(STATUS_LABELS[key])}">
      <button class="btn btn-teal btn-sm" onclick="saveStatusLabel('${key}')">Save</button>
    </div>
  `).join('');
  const customRows = customStatusesData.map(c => renderCustomStatusRow(c)).join('');
  panel.innerHTML = `
    <div style="margin-bottom:6px;"><b style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em;">Built-in statuses</b></div>
    ${builtInRows}
    <div style="margin:22px 0 10px;"><b style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em;">Custom statuses</b></div>
    <div class="auth-hint" style="margin-bottom:14px;">Custom statuses are available as From/To Status options in Workflow Configuration for documentation and reporting. They aren't states a document can actually be in — that's still driven by the 5 built-in statuses above.</div>
    ${customRows || '<div class="master-empty">No custom statuses yet.</div>'}
  `;
}

function renderCustomStatusRow(c){
  const inUse = isCustomStatusInUse(c.id);
  const isEditing = editingCustomStatusId === c.id;
  if(isEditing){
    return `<div class="status-edit-row">
      <input type="text" id="editcustomstatus_${c.id}" value="${escapeHtml(c.name)}" style="max-width:none; flex:1;"
        onkeydown="if(event.key==='Enter'){event.preventDefault(); saveCustomStatusEdit('${c.id}');} if(event.key==='Escape'){cancelCustomStatusEdit();}">
      <button class="btn btn-teal btn-sm" onclick="saveCustomStatusEdit('${c.id}')">Save</button>
      <button class="btn btn-ghost btn-sm" onclick="cancelCustomStatusEdit()">Cancel</button>
    </div>`;
  }
  return `<div class="status-edit-row">
    <span class="status-key" style="width:auto; flex:1; font-family:var(--body); font-size:13px; color:var(--text);">${escapeHtml(c.name)}${inUse ? '<span class="master-inuse-tag">In use</span>' : ''}</span>
    <button class="icon-btn-sm" onclick="startCustomStatusEdit('${c.id}')" title="Edit">&#9999;&#65039;</button>
    <button class="icon-btn-sm" onclick="removeCustomStatus('${c.id}')" title="${inUse ? 'In use — delete disabled' : 'Delete'}" ${inUse ? 'disabled' : ''}>&#128465;&#65039;</button>
  </div>`;
}

function saveStatusLabel(key){
  const input = document.getElementById('statuslabel_' + key);
  const label = input.value.trim();
  if(!label){ toast('Label cannot be empty.', 'err'); return; }
  db.collection('statusLabels').doc(key).set({ label })
    .then(() => toast('Saved.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}

function openCreateStatusModal(){
  document.getElementById('createStatusName').value = '';
  openModal('createStatusModalOverlay');
  setTimeout(() => document.getElementById('createStatusName').focus(), 0);
}
function submitCreateStatus(){
  const name = document.getElementById('createStatusName').value.trim();
  if(!name){ toast('Please enter a status name.', 'err'); return; }
  const dup = customStatusesData.some(c => c.name.toLowerCase() === name.toLowerCase()) ||
    Object.values(DEFAULT_STATUS_LABELS).some(v => v.toLowerCase() === name.toLowerCase());
  if(dup){ toast('That status already exists.', 'err'); return; }
  db.collection('customStatuses').add({ name, createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => { toast('Status created.', 'ok'); closeModal('createStatusModalOverlay'); })
    .catch(err => toast('Could not create: ' + err.message, 'err'));
}
function startCustomStatusEdit(id){
  editingCustomStatusId = id;
  renderStatusConfigView();
  setTimeout(() => { const el = document.getElementById('editcustomstatus_' + id); if(el){ el.focus(); el.select(); } }, 0);
}
function cancelCustomStatusEdit(){
  editingCustomStatusId = null;
  renderStatusConfigView();
}
function saveCustomStatusEdit(id){
  const input = document.getElementById('editcustomstatus_' + id);
  const name = input.value.trim();
  if(!name){ toast('Name cannot be empty.', 'err'); return; }
  const dup = customStatusesData.some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase());
  if(dup){ toast('That status already exists.', 'err'); return; }
  db.collection('customStatuses').doc(id).update({ name })
    .then(() => { editingCustomStatusId = null; toast('Saved.', 'ok'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function removeCustomStatus(id){
  const c = customStatusesData.find(x => x.id === id);
  if(!c) return;
  if(isCustomStatusInUse(id)){ toast('This status is used in a workflow mapping and cannot be deleted.', 'err'); return; }
  if(!confirm(`Are you sure you want to delete this status?\n\n"${c.name}"`)) return;
  db.collection('customStatuses').doc(id).delete()
    .then(() => toast('Status removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}

/* ============================================================
   USERS (admin only)
   Accounts are created here by an Admin, not via public self-registration.
   Creating a user uses a SECONDARY, temporary Firebase App instance so the
   admin's own session isn't disturbed — calling createUserWithEmailAndPassword
   on the primary auth instance would otherwise sign the admin out and into
   the new account, which is Firebase's normal (but unhelpful here) behavior.
============================================================ */
let usersData = [];
let editingUserId = null;
function listenUsers(){
  const unsub = db.collection('users').orderBy('name').onSnapshot(snap => {
    usersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateUaUserSelect(); // always populate — the view itself is admin-gated
    if(currentUser && currentUser.role === 'admin'){
      renderUsersView();
      refreshMasterDataPanels(); // department "in use" status depends on this data
      renderRolesMasterView(); // role "in use" status depends on this data
      renderUserAccessPanel(); // re-render if a user is already selected
    }
    if(typeof onFmUsersChanged === 'function') onFmUsersChanged();
  }, err => console.error('users listener:', err));
  activeSessionUnsubs.push(unsub);
}

function renderUsersView(){
  const body = document.getElementById('usersTableBody');
  if(!body) return;
  if(usersData.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>No users yet</b></div></td></tr>`;
    return;
  }
  body.innerHTML = usersData.map(u => {
    const enabled = u.enabled !== false;
    const isSelf = u.id === currentUser.uid;
    const additionalNames = (u.roles || []).map(r => ROLE_LABELS[r] || r);
    const roleDisplay = `<b>${escapeHtml(ROLE_LABELS[u.role] || u.role || '—')}</b>` + (additionalNames.length ? ` + ${escapeHtml(additionalNames.join(', '))}` : '');
    return `<tr>
      <td>${escapeHtml(u.name || '—')}</td>
      <td>${escapeHtml(u.email || '—')}</td>
      <td>${roleDisplay}</td>
      <td>${escapeHtml(u.department || '—')}</td>
      <td><span class="badge ${enabled ? 'st-published' : 'st-rejected'}"><span class="dot"></span>${enabled ? 'Enabled' : 'Disabled'}</span></td>
      <td style="text-align:right;">
        ${isSelf ? `<span style="font-size:11.5px; color:var(--text-muted); margin-right:8px;">This is you</span>` : ''}
        <button class="icon-btn-sm" onclick="openEditUserModal('${u.id}')" title="Edit">&#9999;&#65039;</button>
      </td>
    </tr>`;
  }).join('');
}

function openEditUserModal(uid){
  const u = usersData.find(x => x.id === uid);
  if(!u) return;
  editingUserId = uid;
  document.getElementById('editUserName').value = u.name || '';
  document.getElementById('editUserEmail').value = u.email || '';
  document.getElementById('editUserRole').value = u.role || '';
  document.getElementById('editUserDept').value = u.department || '';
  document.getElementById('editUserStatus').value = (u.enabled !== false) ? 'enabled' : 'disabled';
  populateRoleDualListbox('editUserRolesAvailable', 'editUserRolesSelected', u.roles || []);
  const isSelf = uid === currentUser.uid;
  document.getElementById('editUserStatus').disabled = isSelf;
  document.getElementById('editUserSelfNote').classList.toggle('hidden', !isSelf);
  openModal('editUserModalOverlay');
}

function submitEditUser(){
  const uid = editingUserId;
  const name = document.getElementById('editUserName').value.trim();
  const role = document.getElementById('editUserRole').value;
  const department = document.getElementById('editUserDept').value;
  const status = document.getElementById('editUserStatus').value;
  const additionalRoles = Array.from(document.getElementById('editUserRolesSelected').options).map(o => o.value);
  if(!name || !role){ toast('Please fill in name and role.', 'err'); return; }
  const updates = { name, role, roles: additionalRoles, department: department || '' };
  if(uid !== currentUser.uid) updates.enabled = (status === 'enabled');
  const btn = document.getElementById('editUserConfirmBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  db.collection('users').doc(uid).update(updates)
    .then(() => { toast('User updated.', 'ok'); closeModal('editUserModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'))
    .finally(() => { btn.disabled = false; btn.textContent = 'Save Changes'; });
}

function sendUserPasswordReset(){
  const u = usersData.find(x => x.id === editingUserId);
  if(!u || !u.email) return;
  auth.sendPasswordResetEmail(u.email)
    .then(() => toast(`Password reset email sent to ${u.email}.`, 'ok'))
    .catch(err => toast('Could not send reset email: ' + err.message, 'err'));
}

function openCreateUserModal(){
  document.getElementById('newUserName').value = '';
  document.getElementById('newUserEmail').value = '';
  document.getElementById('newUserPassword').value = '';
  document.getElementById('newUserRole').value = '';
  document.getElementById('newUserDept').value = '';
  populateRoleDualListbox('newUserRolesAvailable', 'newUserRolesSelected', []);
  openModal('createUserModalOverlay');
}

function submitCreateUser(){
  const name = document.getElementById('newUserName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;
  const department = document.getElementById('newUserDept').value;
  const additionalRoles = Array.from(document.getElementById('newUserRolesSelected').options).map(o => o.value);
  if(!name || !email || !password || !role){ toast('Please fill in name, email, password, and role.', 'err'); return; }
  if(password.length < 6){ toast('Password should be at least 6 characters.', 'err'); return; }

  const btn = document.getElementById('createUserConfirmBtn');
  btn.disabled = true; btn.textContent = 'Creating…';

  const secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary-' + Date.now());
  const secondaryAuth = secondaryApp.auth();

  secondaryAuth.createUserWithEmailAndPassword(email, password)
    .then(cred => db.collection('users').doc(cred.user.uid).set({
      name, email, role, roles: additionalRoles, department: department || '',
      enabled: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid
    }))
    .then(() => secondaryAuth.signOut())
    .then(() => secondaryApp.delete())
    .then(() => {
      toast('User created — share the email and password with them directly.', 'ok');
      closeModal('createUserModalOverlay');
    })
    .catch(err => {
      toast('Could not create user: ' + friendlyAuthError(err), 'err');
      secondaryApp.delete().catch(() => {});
    })
    .finally(() => { btn.disabled = false; btn.textContent = 'Create User'; });
}

/* ============================================================
   BOOTSTRAP
============================================================ */
// Listeners attached per login session (queue, documents, notifications) —
// tracked here so they can be torn down cleanly on logout. Without this,
// they kept running in the background after sign-out with an invalidated
// auth token, getting rejected by the rules on every update and — we
// believe — destabilizing the shared Firestore connection enough to break
// the *next* login's read. listenMasters() is NOT tracked here since it's
// meant to run continuously (public read, needed on the signed-out
// registration screen too).
let activeSessionUnsubs = [];

/* ============================================================
   USER ACCESS  (unified: roles + project staffing + page access per user)
============================================================ */
let pageAccessData = {};
let userPageAccessData = {};
let projectStaffingData = {};

function listenPageAccess(){
  const unsub = db.collection('rolePageAccess').onSnapshot(snap => {
    const data = {};
    snap.docs.forEach(d => { data[d.id] = d.data(); });
    pageAccessData = data;
    applyPageAccessToNav();
  }, err => console.error('rolePageAccess listener:', err));
  activeSessionUnsubs.push(unsub);
}
function listenUserPageAccess(){
  const unsub = db.collection('userPageAccess').onSnapshot(snap => {
    const data = {};
    snap.docs.forEach(d => { data[d.id] = d.data(); });
    userPageAccessData = data;
    applyPageAccessToNav();
  }, err => console.error('userPageAccess listener:', err));
  activeSessionUnsubs.push(unsub);
}
function listenProjectStaffing(){
  const unsub = db.collection('projectStaffing').onSnapshot(snap => {
    const data = {};
    snap.docs.forEach(d => { data[d.id] = d.data(); });
    projectStaffingData = data;
  }, err => console.error('projectStaffing listener:', err));
  activeSessionUnsubs.push(unsub);
}

function canAccessPage(pageKey){
  if(!currentUser) return false;
  if(currentUser.role === 'admin') return true;
  if(!PAGE_ACCESS_ITEMS.some(i => i.key === pageKey)) return true;
  const userAccess = userPageAccessData[currentUser.uid];
  if(userAccess && userAccess.pages && (pageKey in userAccess.pages)){
    return userAccess.pages[pageKey] !== false;
  }
  const myRoles = getUserRoles(currentUser);
  if(myRoles.length === 0) return true;
  return myRoles.some(roleId => {
    const roleAccess = pageAccessData[roleId];
    if(!roleAccess || !roleAccess.pages) return true;
    if(!(pageKey in roleAccess.pages)) return true;
    return roleAccess.pages[pageKey] !== false;
  });
}

function applyPageAccessToNav(){
  if(!currentUser) return;
  const activeEl = document.querySelector('.view.active');
  const activeViewId = activeEl ? activeEl.id : null;
  let activeViewNowHidden = false;
  PAGE_ACCESS_ITEMS.forEach(item => {
    const btn = document.querySelector(`.nav-item[data-view="${item.key}"]`);
    if(!btn) return;
    const allowed = canAccessPage(item.key);
    btn.classList.toggle('hidden', !allowed);
    if(item.key === activeViewId && !allowed) activeViewNowHidden = true;
  });
  if(activeViewNowHidden){
    const fallback = PAGE_ACCESS_ITEMS.find(i => document.getElementById(i.key) && canAccessPage(i.key));
    switchView(fallback ? fallback.key : 'filesView');
  }
  if(typeof renderFmMain === 'function') renderFmMain(); // folder Upload button follows page access
}

function populateUaUserSelect(){
  const sel = document.getElementById('uaUserSelect');
  if(!sel) return;
  // If usersData hasn't arrived from the listener yet, fetch directly
  if(usersData.length === 0){
    db.collection('users').orderBy('name').get().then(snap => {
      usersData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      populateUaUserSelect(); // retry now that we have data
    }).catch(err => console.error('populateUaUserSelect direct fetch:', err));
    return;
  }
  const prevValue = sel.value;
  const nonAdmins = usersData.filter(u => u.role !== 'admin');
  sel.innerHTML = '<option value="">Select a user&hellip;</option>' +
    nonAdmins.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  if(nonAdmins.some(u => u.id === prevValue)) sel.value = prevValue;
}

function renderUserAccessPanel(){
  const panel = document.getElementById('uaPanel');
  if(!panel) return;
  const uid = document.getElementById('uaUserSelect').value;
  if(!uid){ panel.innerHTML = ''; return; }
  const user = usersData.find(u => u.id === uid);
  if(!user){ panel.innerHTML = ''; return; }

  const userAdditionalRoles = new Set(user.roles || []);
  const roleCheckboxes = Object.entries(ROLE_LABELS)
    .filter(([id]) => id !== 'admin' && id !== user.role)
    .map(([id, name]) => `<label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;border-radius:5px;">
      <input type="checkbox" class="ua-role-cb" value="${escapeHtml(id)}" style="width:auto;" ${userAdditionalRoles.has(id) ? 'checked' : ''}>
      <span>${escapeHtml(name)}</span>
    </label>`).join('');

  const userProjects = new Set((projectStaffingData[uid] && projectStaffingData[uid].projects) || []);
  const allProjects = mastersData.projectMasters.filter(p => !p.parentId);
  const projectCheckboxes = allProjects.map(p => `<label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;border-radius:5px;">
    <input type="checkbox" class="ua-proj-cb" value="${escapeHtml(p.name)}" style="width:auto;" ${userProjects.has(p.name) ? 'checked' : ''}>
    <span>${escapeHtml(p.name)}</span>
  </label>`).join('');

  const userOverrides = (userPageAccessData[uid] && userPageAccessData[uid].pages) || {};
  const myRoles = getUserRoles(user);
  function roleDefaultFor(pageKey){
    if(myRoles.length === 0) return true;
    return myRoles.some(roleId => {
      const roleAccess = pageAccessData[roleId];
      if(!roleAccess || !roleAccess.pages) return true;
      if(!(pageKey in roleAccess.pages)) return true;
      return roleAccess.pages[pageKey] !== false;
    });
  }
  const pageRows = PAGE_ACCESS_ITEMS.map(item => {
    const hasOverride = item.key in userOverrides;
    const roleDefault = roleDefaultFor(item.key);
    const effective = hasOverride ? userOverrides[item.key] !== false : roleDefault;
    return `<label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;border-radius:5px;">
      <input type="checkbox" class="ua-page-cb" value="${item.key}" style="width:auto;" ${effective ? 'checked' : ''}>
      <span>${escapeHtml(item.label)}${hasOverride ? '<span class="master-inuse-tag" style="margin-left:6px;">Custom</span>' : ''}</span>
    </label>`;
  }).join('');

  panel.innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">
      <div class="card" style="padding:16px;">
        <div style="font-weight:700; font-size:12.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin-bottom:12px;">Roles</div>
        <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:10px;">Primary role: <b>${escapeHtml(ROLE_LABELS[user.role] || user.role)}</b> (change via Edit User)</div>
        <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">Additional roles:</div>
        ${roleCheckboxes || '<div class="master-empty">No other roles defined yet.</div>'}
      </div>
      <div class="card" style="padding:16px;">
        <div style="font-weight:700; font-size:12.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin-bottom:12px;">Project Access</div>
        <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:8px;">Projects this user is staffed on:</div>
        ${projectCheckboxes || '<div class="master-empty">No projects in Masters &rarr; Project Master yet.</div>'}
      </div>
    </div>
    <div class="card" style="padding:16px; margin-bottom:16px;">
      <div style="font-weight:700; font-size:12.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); margin-bottom:10px;">Page Access</div>
      <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:12px;">Pages this user can see. <b>Custom</b> means a per-user override is already set; everything else follows their role(s) by default.</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:4px;">${pageRows}</div>
    </div>
    <div style="display:flex; gap:10px; align-items:center;">
      <button class="btn btn-teal" id="uaSaveBtn" onclick="saveUserAccess('${uid}')">Save</button>
      <button class="btn btn-ghost" onclick="resetUserAccess('${uid}')">Reset page access to defaults</button>
    </div>
  `;
}

function saveUserAccess(uid){
  const user = usersData.find(u => u.id === uid);
  if(!user) return;
  const additionalRoles = Array.from(document.querySelectorAll('.ua-role-cb:checked')).map(cb => cb.value);
  const selectedProjects = Array.from(document.querySelectorAll('.ua-proj-cb:checked')).map(cb => cb.value);
  const myRoles = [...getUserRoles({ role: user.role, roles: additionalRoles })];
  function roleDefaultFor(pageKey){
    if(myRoles.length === 0) return true;
    return myRoles.some(roleId => {
      const roleAccess = pageAccessData[roleId];
      if(!roleAccess || !roleAccess.pages) return true;
      if(!(pageKey in roleAccess.pages)) return true;
      return roleAccess.pages[pageKey] !== false;
    });
  }
  const pageDiff = {};
  PAGE_ACCESS_ITEMS.forEach(item => {
    const cb = document.querySelector(`.ua-page-cb[value="${item.key}"]`);
    if(!cb) return;
    if(cb.checked !== roleDefaultFor(item.key)) pageDiff[item.key] = cb.checked;
  });
  const btn = document.getElementById('uaSaveBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  Promise.all([
    db.collection('users').doc(uid).update({ roles: additionalRoles }),
    db.collection('projectStaffing').doc(uid).set({ projects: selectedProjects }),
    Object.keys(pageDiff).length > 0
      ? db.collection('userPageAccess').doc(uid).set({ pages: pageDiff })
      : db.collection('userPageAccess').doc(uid).delete().catch(() => {})
  ]).then(() => toast('Saved.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'))
    .finally(() => { if(btn){ btn.disabled = false; btn.textContent = 'Save'; } });
}

function resetUserAccess(uid){
  if(!confirm("Clear all custom page-access overrides for this user? Their page access will follow their roles' defaults again.")) return;
  db.collection('userPageAccess').doc(uid).delete()
    .then(() => { toast('Page access reset to role defaults.', 'ok'); renderUserAccessPanel(); })
    .catch(err => toast('Could not reset: ' + err.message, 'err'));
}

function startListeners(){
  stopSessionListeners(); // safety: clear anything left over before attaching fresh ones
  populateStatusFilterOptions(); // seed with current STATUS_LABELS immediately, live listener refines it
  listenQueue();
  listenAllDocuments();
  listenNotifications();
  listenWorkflowConfigs();
  listenStatusLabels();
  listenRoleMasters();
  listenProjectStaffing();
  listenPageAccess();
  listenUserPageAccess();
  listenUsers();
  if(typeof startFilesListeners === 'function') startFilesListeners();
  refreshMasterDataPanels(); // in case this admin's panels were open before this fired
}

function stopSessionListeners(){
  if(typeof stopFilesListeners === 'function') stopFilesListeners();
  activeSessionUnsubs.forEach(unsub => { try{ unsub(); }catch(e){} });
  activeSessionUnsubs = [];
  queueMap = new Map();
  allDocsSnapshot = [];
  notifMap = new Map();
  usersData = [];
  roleMastersData = [];
  editingMasterItem = null;
  editingRoleId = null;
  workflowConfigStepsData = [];
  activeWorkflowCategory = null;
  customStatusesData = [];
  editingCustomStatusId = null;
  pageAccessData = {};
  userPageAccessData = {};
  projectStaffingData = {};
  STATUS_LABELS = { ...DEFAULT_STATUS_LABELS };
  ROLE_LABELS = { ...DEFAULT_ROLE_LABELS };
}

listenMasters(); // public read — populate upload dropdowns even before sign-in
