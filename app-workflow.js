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
function isOverdue(v){
  const ms = v.uploadedAt && v.uploadedAt.toMillis ? v.uploadedAt.toMillis() : 0;
  return ms > 0 && (Date.now() - ms) > (2*24*60*60*1000);
}
function humanizeAction(a){
  return { uploaded:'uploaded the document', step_approved:'approved a step', step_rejected:'rejected the document', resubmitted:'submitted a revised version' }[a] || a;
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
  openDocumentDetail(docId);
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
let queueShowOverdueOnly = false;
function toggleOverdueOnly(){
  queueShowOverdueOnly = !queueShowOverdueOnly;
  renderQueue();
}
function listenQueue(){
  const unsub = db.collectionGroup('versions').where('status','in',['pending_review','pending_approval'])
    .onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if(ch.type === 'removed') queueMap.delete(ch.doc.id);
        else queueMap.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
      });
      renderQueue();
    }, err => {
      console.error('queue listener:', err);
      document.getElementById('queueList').innerHTML =
        `<div class="empty-state"><b>Could not load queue</b><div>${escapeHtml(err.message)}</div></div>`;
    });
  activeSessionUnsubs.push(unsub);
}
function renderQueue(){
  const myRoles = getUserRoles(currentUser);
  let mine = Array.from(queueMap.values()).filter(v =>
    (v.steps||[]).some(s => s.stage === v.currentStage && s.decision === 'pending' && (myRoles.includes(s.role) || currentUser.role === 'admin'))
  );
  mine.sort((a,b) => ((a.uploadedAt&&a.uploadedAt.toMillis)?a.uploadedAt.toMillis():0) - ((b.uploadedAt&&b.uploadedAt.toMillis)?b.uploadedAt.toMillis():0));

  const badge = document.getElementById('queueBadge');
  badge.textContent = mine.length;
  badge.classList.toggle('hidden', mine.length === 0);

  const overdueCount = mine.filter(isOverdue).length;
  const publishedCount = allDocsSnapshot.filter(d => d.status === 'published').length;
  document.getElementById('queueStats').innerHTML = `
    <div class="stat-card accent-gold"><div class="num">${mine.length}</div><div class="lbl">Awaiting your action</div></div>
    <div class="stat-card accent-red clickable ${queueShowOverdueOnly?'stat-active':''}" onclick="toggleOverdueOnly()"><div class="num">${overdueCount}</div><div class="lbl">Overdue &gt; 2 days${queueShowOverdueOnly?' &middot; showing only these':''}</div></div>
    <div class="stat-card accent-teal clickable" onclick="goToDocumentsFiltered('')"><div class="num">${queueMap.size}</div><div class="lbl">Active in the workflow</div></div>
    <div class="stat-card clickable" onclick="goToDocumentsFiltered('published')"><div class="num">${publishedCount}</div><div class="lbl">Published documents</div></div>`;

  if(queueShowOverdueOnly) mine = mine.filter(isOverdue);
  const list = document.getElementById('queueList');
  if(mine.length === 0){
    const myRoleNames = myRoles.map(r => ROLE_LABELS[r] || r).join(', ');
    list.innerHTML = queueShowOverdueOnly
      ? `<div class="empty-state"><div class="ic">&#9989;</div><b>Nothing overdue</b><div>None of your pending items are over 2 days old. <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="toggleOverdueOnly()">Show all</button></div></div>`
      : `<div class="empty-state"><div class="ic">&#9989;</div><b>Queue clear</b><div>Nothing is waiting on your ${escapeHtml(myRoleNames)} approval right now.</div></div>`;
    return;
  }
  list.innerHTML = mine.map(v => {
    const myStep = v.steps.find(s => s.stage === v.currentStage && s.decision === 'pending' && (myRoles.includes(s.role) || currentUser.role === 'admin'));
    const maxStage = Math.max(...v.steps.map(s => s.stage));
    const isFinal = myStep.stage === maxStage;
    const overdue = isOverdue(v);
    const chips = v.steps.map(s => {
      let cls = 'pending';
      if(s.decision === 'approved') cls = 'approved';
      else if(s.decision === 'rejected') cls = 'rejected';
      else if(s.stage === v.currentStage) cls = 'active-pending';
      return `<span class="step-chip ${cls}">${escapeHtml(s.label)}</span>`;
    }).join('');
    return `<div class="queue-card ${overdue?'overdue':''}">
      <div class="queue-main">
        <div class="queue-title-row"><h4>${escapeHtml(v.docTitle)}</h4><span class="drawing-code">${escapeHtml(v.docDrawingNumber)}</span></div>
        <div class="queue-meta">${escapeHtml(v.docProject)} &middot; Uploaded by <b>${escapeHtml(v.uploadedByName)}</b> &middot; ${timeAgo(v.uploadedAt)}${overdue?' &middot; <span class="overdue-tag">Overdue</span>':''}</div>
        <div class="step-chip-row">${chips}</div>
      </div>
      <div class="queue-actions">
        <button class="btn btn-teal btn-sm" onclick="openDecisionModal('${v.docId}','${v.id}','${myStep.key}','approved','${escapeJs(myStep.label)}',${isFinal})">Approve</button>
        <button class="btn btn-red btn-sm" onclick="openDecisionModal('${v.docId}','${v.id}','${myStep.key}','rejected','${escapeJs(myStep.label)}',${isFinal})">Reject</button>
        <button class="btn btn-ghost btn-sm" onclick="openDocumentDetail('${v.docId}')">Details</button>
      </div>
    </div>`;
  }).join('');
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
    document.getElementById('docsTableBody').innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>Could not load documents</b></div></td></tr>`;
  });
  activeSessionUnsubs.push(unsub);
}
let docFilters = { project: '', department: '', category: '', status: '' };
function applyDocFilters(){
  docFilters.project = document.getElementById('filterProject').value;
  docFilters.department = document.getElementById('filterDepartment').value;
  docFilters.category = document.getElementById('filterCategory').value;
  docFilters.status = document.getElementById('filterStatus').value;
  renderDocsTable();
}
function clearDocFilters(){
  docFilters = { project: '', department: '', category: '', status: '' };
  document.getElementById('filterProject').value = '';
  document.getElementById('filterDepartment').value = '';
  document.getElementById('filterCategory').value = '';
  document.getElementById('filterStatus').value = '';
  renderDocsTable();
}
// Jump to Documents pre-filtered by status — used by the clickable stat
// cards on My Approval Queue (e.g. "Published documents").
function goToDocumentsFiltered(statusKey){
  clearDocFilters();
  docFilters.status = statusKey || '';
  const sel = document.getElementById('filterStatus');
  if(sel) sel.value = docFilters.status;
  switchView('docsView');
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
  const filtered = allDocsSnapshot.filter(d =>
    (!docFilters.project || d.project === docFilters.project) &&
    (!docFilters.department || d.department === docFilters.department) &&
    (!docFilters.category || d.category === docFilters.category) &&
    (!docFilters.status || d.status === docFilters.status)
  );
  if(allDocsSnapshot.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="ic">&#128193;</div><b>No documents yet</b><div>Upload the first one from the Upload Document tab.</div></div></td></tr>`;
    return;
  }
  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="ic">&#128269;</div><b>No documents match these filters</b><div><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="clearDocFilters()">Clear filters</button></div></div></td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(d => `
    <tr onclick="openDocumentDetail('${d.id}')">
      <td><span class="drawing-code">${escapeHtml(d.drawingNumber||'—')}</span></td>
      <td>${escapeHtml(d.title||'—')}</td>
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
    .then(([docSnap, versionsSnap]) => {
      if(!docSnap.exists){
        document.getElementById('detailBody').innerHTML = '<div class="empty-state"><b>Document not found</b></div>';
        return;
      }
      const docData = docSnap.data();
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
      s.stage === latest.currentStage && (myRolesForDetail.includes(s.role) || currentUser.role === 'admin');
    const isFinal = s.stage === maxStage;
    const icon = s.decision === 'approved' ? '&#10003;' : s.decision === 'rejected' ? '&#10007;' : (rowCls === 'active' ? '&#8987;' : '&hellip;');
    let extra;
    if(s.decision !== 'pending'){
      extra = `<div class="m">${s.decision === 'approved' ? 'Approved' : 'Rejected'} by <b>${escapeHtml(s.decidedByName||'')}</b> &middot; ${timeAgo(s.decidedAt)}</div>`;
      if(s.remarks) extra += `<div class="remarks">${escapeHtml(s.remarks)}</div>`;
    } else {
      extra = `<div class="m">Assigned to ${escapeHtml(ROLE_LABELS[s.role]||s.role)}${currentUser.role==='admin'?' <span style="color:var(--gold);">(admin override available)</span>':''}</div>`;
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
      <div><span>Project</span>${escapeHtml(docData.project)}</div>
      <div><span>Department</span>${escapeHtml(docData.department)}</div>
      <div><span>Category</span>${escapeHtml(docData.category)}</div>
      <div><span>Current Revision</span>${escapeHtml(latest.revision)}</div>
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
      notifyUser(result.uploadedBy, `${result.docDrawingNumber} — ${result.docTitle} was rejected. See remarks and resubmit.`, docId);
      toast('Document rejected. The uploader has been notified.', 'ok');
    } else if(result.published){
      notifyUser(result.uploadedBy, `${result.docDrawingNumber} — ${result.docTitle} has been approved and published.`, docId);
      toast('Approved, signed, and published.', 'ok');
    } else if(result.newStatus === 'pending_approval'){
      const nextRoles = result.steps.filter(s => s.stage === result.newStage).map(s => s.role);
      notifyRoles(nextRoles, `${result.docDrawingNumber} — ${result.docTitle} is ready for your approval.`, docId);
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
  const revision = document.getElementById('resubRevision').value.trim();
  if(!revision){ toast('Please enter a revision label.', 'err'); return; }

  const docRef = db.collection('documents').doc(activeDocId);
  const btn = document.getElementById('resubmitConfirmBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';

  docRef.get().then(docSnap => {
    const docData = docSnap.data();
    const resolved = resolveWorkflowForCategory(docData.category);
    if(!resolved){
      toast(getWorkflowResolutionIssue(docData.category), 'err');
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
            status: 'pending_review', currentStage: 0, steps: freshSteps(resolved.steps),
            workflowConfigId: resolved.configId, workflowConfigName: resolved.configName,
            signedBy: null, signedAt: null, supersededBy: null,
            docTitle: docData.title, docDrawingNumber: docData.drawingNumber, docProject: docData.project, docId: activeDocId
          };
          const batch = db.batch();
          batch.set(newVersionRef, versionData);
          batch.update(oldVersionDoc.ref, { supersededBy: newVersionRef.id });
          batch.update(docRef, { currentVersionNo: newVersionNo, currentVersionId: newVersionRef.id, status: 'pending_review', updatedAt: ts });
          batch.set(newVersionRef.collection('history').doc(), {
            action: 'resubmitted', actor: currentUser.uid, actorName: currentUser.name, timestamp: ts, remarks: null, toStatus: 'pending_review'
          });
          batch.commit().then(() => {
            notifyRoles(resolved.steps.filter(s => s.stage === 0).map(s => s.role), `${docData.drawingNumber} — ${docData.title} resubmitted (v${newVersionNo}) and needs review.`, activeDocId);
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
  { key: 'projectMasters',    label: 'Projects',    singular: 'project',    selects: ['fProject','filterProject','qcObsProject','qcInspProject','matLogProject','matRptProject','snagProject','snagRptProject','editSnagProject','goodWorkProject','goodWorkRptProject','editGoodWorkProject'],
    hasSubItems: true, panelId: 'projectsMasterPanel',
    starter: ['MP Winter','MP Merlin','MP Golden Heights','MP Pace Petals','MP Eden'],
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
    isInUse: item => allDocsSnapshot.some(d => d.category === item.name) },
  { key: 'qcCategoryMasters', label: 'QC Categories', singular: 'QC category', selects: ['qcObsCategory'],
    hasSubItems: false, panelId: 'qcCategoriesMasterPanel',
    starter: ['Civil','Electrical','Plumbing','Finishing','Structural'],
    inUseMessage: 'This QC category is in use and cannot be deleted.',
    isInUse: item => qcObservationsData.some(o => o.qcCategory === item.name) },
  { key: 'materialMasters', label: 'Materials', singular: 'material', selects: ['materialTestDetailMaterial','matLogMaterial','matRptMaterial'],
    hasSubItems: false, panelId: 'materialsMasterPanel',
    starter: ['Solid Block','AAC Blocks','Rebar 12mm TMT','Cube Test','Soil Test Report'],
    inUseMessage: 'This material is in use and cannot be deleted.',
    isInUse: item => materialTestDetailsData.some(d => d.materialId === item.id) || materialTestLogsData.some(l => l.materialId === item.id) }
];
let mastersData = { projectMasters: [], departmentMasters: [], categoryMasters: [], qcCategoryMasters: [], materialMasters: [] };
let expandedMasterItems = { projectMasters: new Set(), departmentMasters: new Set(), categoryMasters: new Set(), qcCategoryMasters: new Set(), materialMasters: new Set() };
let editingMasterItem = null; // { typeKey, id }

function listenMasters(){
  MASTER_TYPES.forEach(mt => {
    const unsub = db.collection(mt.key).orderBy('name').onSnapshot(snap => {
      mastersData[mt.key] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const topLevel = mastersData[mt.key].filter(it => !it.parentId);
      mt.selects.forEach(selId => populateSelect(selId, topLevel));
      refreshMasterDataPanels();
      if(mt.key === 'categoryMasters' && currentUser && currentUser.role === 'admin') renderWorkflowConfigView();
      if(mt.key === 'qcCategoryMasters' && currentUser && currentUser.role === 'admin' && activeWfModule === 'qc') renderQcWorkflowConfigView();
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
   Document Category (from Manage Document Categories) plus a Default row
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
  if(!category){ el.innerHTML = ''; return; }
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
       <div class="auth-hint" style="margin-top:14px;">Categories come from <b>Manage Document Categories</b> — add one there and it shows up here automatically.</div>`;
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

// --- Workflow Configuration module tabs ---
let activeWfModule = 'dms'; // 'dms' | 'qc'

function switchWfModule(module){
  activeWfModule = module;
  const dmsTab = document.getElementById('wfTabDms');
  const qcTab = document.getElementById('wfTabQc');
  const dmsPnl = document.getElementById('wfPanelDms');
  const qcPnl = document.getElementById('wfPanelQc');
  if(!dmsTab || !qcTab || !dmsPnl || !qcPnl) return;
  // Active tab = teal filled, inactive = ghost
  if(module === 'dms'){
    dmsTab.className = 'btn btn-teal';
    qcTab.className = 'btn btn-ghost';
  } else {
    dmsTab.className = 'btn btn-ghost';
    qcTab.className = 'btn btn-teal';
  }
  dmsPnl.style.display = module === 'dms' ? '' : 'none';
  qcPnl.style.display = module === 'qc' ? '' : 'none';
  if(module === 'dms') renderWorkflowConfigView();
  if(module === 'qc') renderQcWorkflowConfigView();
}

// --- QC Workflow Configuration (parallel to DMS but keyed by QC Categories) ---
// Uses a separate Firestore collection `qcWorkflowConfigSteps` so QC
// workflows are independent of DMS document workflows.
let qcWorkflowConfigStepsData = [];
let activeQcWorkflowCategory = null; // null = list; string = detail

function listenQcWorkflowConfigs(){
  const unsub = db.collection('qcWorkflowConfigSteps').onSnapshot(snap => {
    qcWorkflowConfigStepsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if(currentUser && currentUser.role === 'admin' && activeWfModule === 'qc') renderQcWorkflowConfigView();
  }, err => console.error('qcWorkflowConfigSteps listener:', err));
  activeSessionUnsubs.push(unsub);
}

function renderQcWorkflowConfigView(){
  const panel = document.getElementById('qcWorkflowConfigPanel');
  if(!panel) return;
  if(activeQcWorkflowCategory !== null) renderQcWorkflowConfigDetail(panel);
  else renderQcWorkflowConfigList(panel);
}

function renderQcWorkflowConfigList(panel){
  const categories = mastersData.qcCategoryMasters.filter(c => !c.parentId);
  const rows = [{ category: '', displayName: 'Default', isDefault: true }, ...categories.map(c => ({ category: c.name, displayName: c.name, isDefault: false }))]
    .map(row => {
      const stepCount = qcWorkflowConfigStepsData.filter(s => s.category === row.category).length;
      return `<tr onclick="openQcWorkflowConfigDetail('${escapeJs(row.category)}')">
        <td>${escapeHtml(row.displayName)}${row.isDefault ? ' <span style="color:var(--text-muted); font-weight:400;">(any QC category without its own workflow)</span>' : ''}</td>
        <td>${stepCount} step${stepCount === 1 ? '' : 's'}</td>
        <td style="text-align:right;"><button class="icon-btn-sm" onclick="event.stopPropagation(); openQcWorkflowConfigDetail('${escapeJs(row.category)}')" title="Configure">&#9999;&#65039;</button></td>
      </tr>`;
    }).join('');
  panel.innerHTML = `<table><thead><tr><th>QC Category</th><th>Steps</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="auth-hint" style="margin-top:14px;">Categories come from <b>Manage QC Categories</b> — add one there and it shows up here automatically.</div>`;
}

function renderQcWorkflowConfigDetail(panel){
  const category = activeQcWorkflowCategory;
  const isDefault = category === '';
  const displayName = isDefault ? 'Default QC Workflow' : category;
  const allStatusOptions = getAllStatusOptions();
  const stepsRaw = qcWorkflowConfigStepsData.filter(s => s.category === category);
  const chainResult = computeStatusChain(stepsRaw);

  let tableOrWarning;
  if(stepsRaw.length === 0){
    tableOrWarning = `<div class="master-empty">No steps yet — add at least one below.</div>`;
  } else if(!chainResult.ok){
    tableOrWarning = `<div class="auth-error" style="display:block; margin-bottom:16px;">${escapeHtml(chainResult.error)}</div>
      <table><thead><tr><th>Role</th><th>From Status</th><th>To Status</th><th></th></tr></thead><tbody>
        ${stepsRaw.map(s => `<tr>
          <td>${escapeHtml(ROLE_LABELS[s.role] || s.role)}</td>
          <td>${escapeHtml(allStatusOptions[s.fromStatus] || s.fromStatus || '—')}</td>
          <td>${escapeHtml(allStatusOptions[s.toStatus] || s.toStatus || '—')}</td>
          <td style="text-align:right;"><button class="icon-btn-sm" onclick="removeQcWorkflowConfigStep('${s.id}')" title="Delete">&#128465;&#65039;</button></td>
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
        <td style="text-align:right;"><button class="icon-btn-sm" onclick="removeQcWorkflowConfigStep('${s.id}')" title="Delete">&#128465;&#65039;</button></td>
      </tr>`;
    }).join('');
    tableOrWarning = `<table><thead><tr><th style="width:50px;">#</th><th>Role</th><th>From Status</th><th>To Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const statusOptionsHtml = Object.entries(allStatusOptions).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('');
  panel.innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="backToQcWorkflowList()" style="margin-bottom:16px;">&larr; Back to QC Workflows</button>
    <h3 style="margin-bottom:3px;">${escapeHtml(displayName)}</h3>
    <div style="font-size:12.5px; color:var(--text-muted); margin-bottom:18px;">${isDefault ? 'Applies to any QC Category without its own steps below' : `QC Category: <b>${escapeHtml(category)}</b>`}</div>
    ${tableOrWarning}
    <div class="workflow-add-block" style="margin-top:20px; padding-top:18px; border-top:1px solid var(--border);">
      <h4>Add Workflow Mapping</h4>
      <div class="workflow-add-row">
        <select id="qcNewStepRole">
          <option value="">Role&hellip;</option>
          ${Object.entries(ROLE_LABELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
        </select>
        <select id="qcNewStepFromStatus"><option value="">From Status&hellip;</option>${statusOptionsHtml}</select>
        <select id="qcNewStepToStatus"><option value="">To Status&hellip;</option>${statusOptionsHtml}</select>
        <button class="btn btn-teal btn-sm" onclick="addQcWorkflowConfigStep()">+ Add Mapping</button>
      </div>
      <div class="auth-hint" style="margin-top:10px;">The sequence is worked out automatically by matching each step's To Status to the next step's From Status. Steps sharing a From Status run in parallel.</div>
    </div>
  `;
}

function openQcWorkflowConfigDetail(category){
  activeQcWorkflowCategory = category;
  renderQcWorkflowConfigView();
}
function backToQcWorkflowList(){
  activeQcWorkflowCategory = null;
  renderQcWorkflowConfigView();
}
function addQcWorkflowConfigStep(){
  const category = activeQcWorkflowCategory;
  const role = document.getElementById('qcNewStepRole').value;
  const fromStatus = document.getElementById('qcNewStepFromStatus').value;
  const toStatus = document.getElementById('qcNewStepToStatus').value;
  if(!role){ toast('Please choose a role.', 'err'); return; }
  if(!fromStatus || !toStatus){ toast('Please choose both From Status and To Status.', 'err'); return; }
  if(fromStatus === toStatus){ toast('From Status and To Status can\'t be the same.', 'err'); return; }
  const existingSteps = qcWorkflowConfigStepsData.filter(s => s.category === category);
  if(existingSteps.some(s => s.role === role && s.fromStatus === fromStatus && s.toStatus === toStatus)){ toast('An identical mapping already exists.', 'err'); return; }
  const conflicting = existingSteps.find(s => s.fromStatus === fromStatus && s.toStatus !== toStatus);
  if(conflicting){ toast('Another step from this status leads to a different next status — parallel steps at the same point must lead to the same next status.', 'err'); return; }
  db.collection('qcWorkflowConfigSteps').add({
    category, label: ROLE_LABELS[role] || role, role, fromStatus, toStatus,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => toast('Mapping added.', 'ok'))
    .catch(err => toast('Could not add: ' + err.message, 'err'));
}
function removeQcWorkflowConfigStep(stepId){
  const step = qcWorkflowConfigStepsData.find(s => s.id === stepId);
  if(!step) return;
  const categorySteps = qcWorkflowConfigStepsData.filter(s => s.category === step.category);
  if(step.category === '' && categorySteps.length <= 1){ toast('The Default QC workflow needs at least one step.', 'err'); return; }
  if(!confirm(`Are you sure you want to remove this workflow mapping?\n\n"${ROLE_LABELS[step.role] || step.role}"`)) return;
  db.collection('qcWorkflowConfigSteps').doc(stepId).delete()
    .then(() => toast('Mapping removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
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
    populateSnagUserSelects();
    populateUaUserSelect(); // always populate — the view itself is admin-gated
    if(currentUser && currentUser.role === 'admin'){
      renderUsersView();
      refreshMasterDataPanels(); // department "in use" status depends on this data
      renderRolesMasterView(); // role "in use" status depends on this data
      renderUserAccessPanel(); // re-render if a user is already selected
    }
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
   QC OBSERVATION LIFECYCLE
   A site quality observation moves through: open -> rectified -> rechecked
   -> approved (or back to open, with rejectReason/rejectCount incremented,
   if the Project Head rejects at final approval). Unlike the document
   approval engine, this first phase is intentionally NOT role-gated — any
   signed-in user can act at any stage. Deferred for a later phase: QC
   Codes master, the standalone exportable report screens, and per-stage
   role restrictions (e.g. only a "Project Head" role can approve).
============================================================ */
let qcObservationsData = [];
let qcObsFile = null;
let qcRectifyFile = null;
let activeQcObservationId = null;

function listenQcObservations(){
  const unsub = db.collection('qcObservations').orderBy('createdAt', 'desc').onSnapshot(snap => {
    qcObservationsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderQcObsTable();
    renderQcRectifyTable();
    renderQcRecheckTable();
    renderQcPhApprovalTable();
    refreshMasterDataPanels(); // QC category "in use" status depends on this data
  }, err => console.error('qcObservations listener:', err));
  activeSessionUnsubs.push(unsub);
}

function qcSeverityBadge(sev){
  const map = { minor: 'st-pending_review', major: 'st-pending_approval', critical: 'st-rejected' };
  const label = { minor: 'Minor', major: 'Major', critical: 'Critical' };
  return `<span class="badge ${map[sev] || ''}"><span class="dot"></span>${label[sev] || sev}</span>`;
}
function qcStatusBadge(status){
  const map = { open: 'st-pending_review', rectified: 'st-pending_approval', rechecked: 'st-approved', approved: 'st-published', rejected: 'st-rejected' };
  const label = { open: 'Open', rectified: 'Rectified', rechecked: 'Rechecked', approved: 'Approved', rejected: 'Rejected' };
  return `<span class="badge ${map[status] || ''}"><span class="dot"></span>${label[status] || status}</span>`;
}

// --- Log Observation form ---
(function wireQcObsDropzone(){
  const dz = document.getElementById('qcObsDropzone');
  const fi = document.getElementById('qcObsFile');
  if(dz && fi){
    fi.addEventListener('change', () => {
      qcObsFile = fi.files[0] || null;
      document.getElementById('qcObsFilePillWrap').innerHTML = qcObsFile ? `<div class="file-pill">${escapeHtml(qcObsFile.name)}</div>` : '';
    });
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag');
      if(e.dataTransfer.files[0]){ fi.files = e.dataTransfer.files; qcObsFile = e.dataTransfer.files[0]; document.getElementById('qcObsFilePillWrap').innerHTML = `<div class="file-pill">${escapeHtml(qcObsFile.name)}</div>`; }
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  const dateInput = document.getElementById('qcObsDate');
  if(dateInput) dateInput.value = today;
})();

function handleQcObservationSubmit(ev){
  ev.preventDefault();
  const meta = {
    project: document.getElementById('qcObsProject').value,
    inspectionDate: document.getElementById('qcObsDate').value,
    flat: document.getElementById('qcObsFlat').value.trim(),
    location: document.getElementById('qcObsLocation').value.trim(),
    qcCategory: document.getElementById('qcObsCategory').value,
    severity: document.getElementById('qcObsSeverity').value,
    observation: document.getElementById('qcObsText').value.trim()
  };
  if(!meta.project || !meta.location || !meta.qcCategory || !meta.severity || !meta.observation){
    toast('Please fill in all required fields.', 'err');
    return false;
  }
  const btn = document.getElementById('qcObsSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const repeatCount = qcObservationsData.filter(o => o.qcCategory === meta.qcCategory).length + 1;

  const finish = (attachmentURL) => {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    db.collection('qcObservations').add({
      ...meta, attachmentURL: attachmentURL || null, repeatCount,
      status: 'open', rejectCount: 0,
      inspectedBy: currentUser.uid, inspectedByName: currentUser.name,
      createdAt: now, updatedAt: now
    }).then(() => {
      toast('Observation logged.', 'ok');
      document.getElementById('qcObsForm').reset();
      qcObsFile = null;
      document.getElementById('qcObsFilePillWrap').innerHTML = '';
      document.getElementById('qcObsDate').value = new Date().toISOString().slice(0, 10);
    }).catch(err => toast('Could not save: ' + err.message, 'err'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Add Observation'; document.getElementById('qcObsProgressWrap').style.display = 'none'; });
  };

  if(qcObsFile){
    const path = `qcObservations/${Date.now()}_${qcObsFile.name}`;
    const task = storage.ref(path).put(qcObsFile);
    document.getElementById('qcObsProgressWrap').style.display = 'block';
    task.on('state_changed',
      snap => { document.getElementById('qcObsProgressBar').style.width = ((snap.bytesTransferred / snap.totalBytes) * 100) + '%'; },
      err => { toast('Upload failed: ' + err.message, 'err'); btn.disabled = false; btn.textContent = 'Add Observation'; },
      () => task.snapshot.ref.getDownloadURL().then(finish)
    );
  } else {
    finish(null);
  }
  return false;
}

function renderQcObsTable(){
  const body = document.getElementById('qcObsTableBody');
  if(!body) return;
  if(qcObservationsData.length === 0){
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><b>No observations logged yet</b></div></td></tr>`;
    return;
  }
  body.innerHTML = qcObservationsData.map(o => `
    <tr>
      <td>${escapeHtml(o.project || '—')}</td>
      <td>${escapeHtml(o.location || '—')}${o.flat ? ` &middot; ${escapeHtml(o.flat)}` : ''}</td>
      <td>${escapeHtml(o.qcCategory || '—')}</td>
      <td>${qcSeverityBadge(o.severity)}</td>
      <td style="max-width:320px;">${escapeHtml(o.observation || '—')}</td>
      <td>${qcStatusBadge(o.status)}</td>
      <td>${timeAgo(o.createdAt)}</td>
    </tr>`).join('');
}

// --- Rectify ---
function renderQcRectifyTable(){
  const body = document.getElementById('qcRectifyTableBody');
  const openItems = qcObservationsData.filter(o => o.status === 'open');
  const badge = document.getElementById('qcRectifyBadge');
  if(badge){ badge.textContent = openItems.length; badge.classList.toggle('hidden', openItems.length === 0); }
  if(!body) return;
  if(openItems.length === 0){
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><b>Nothing awaiting rectification</b></div></td></tr>`;
    return;
  }
  body.innerHTML = openItems.map(o => `
    <tr>
      <td>${escapeHtml(o.project || '—')}</td>
      <td>${escapeHtml(o.location || '—')}${o.flat ? ` &middot; ${escapeHtml(o.flat)}` : ''}</td>
      <td>${escapeHtml(o.qcCategory || '—')}</td>
      <td>${qcSeverityBadge(o.severity)}</td>
      <td style="max-width:320px;">${escapeHtml(o.observation || '—')}${o.rejectReason ? `<div style="color:var(--red); font-size:11.5px; margin-top:4px;">Sent back: ${escapeHtml(o.rejectReason)}</div>` : ''}</td>
      <td>${timeAgo(o.createdAt)}</td>
      <td><button class="btn btn-teal btn-sm" onclick="openQcRectifyModal('${o.id}')">Rectify</button></td>
    </tr>`).join('');
}
function openQcRectifyModal(id){
  activeQcObservationId = id;
  document.getElementById('qcRectifyRemarks').value = '';
  document.getElementById('qcRectifyFile').value = '';
  qcRectifyFile = null;
  openModal('qcRectifyModalOverlay');
}
function submitQcRectify(){
  const id = activeQcObservationId;
  const remarks = document.getElementById('qcRectifyRemarks').value.trim();
  const file = document.getElementById('qcRectifyFile').files[0] || null;
  const btn = document.getElementById('qcRectifyConfirmBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const finish = (imageURL) => {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    db.collection('qcObservations').doc(id).update({
      status: 'rectified', rectifiedBy: currentUser.uid, rectifiedByName: currentUser.name,
      rectifiedAt: now, rectifiedRemarks: remarks || null, rectifiedImageURL: imageURL || null, updatedAt: now
    }).then(() => { toast('Marked as rectified.', 'ok'); closeModal('qcRectifyModalOverlay'); })
      .catch(err => toast('Could not save: ' + err.message, 'err'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Mark Rectified'; document.getElementById('qcRectifyProgressWrap').style.display = 'none'; });
  };
  if(file){
    const path = `qcObservations/rectify_${Date.now()}_${file.name}`;
    const task = storage.ref(path).put(file);
    document.getElementById('qcRectifyProgressWrap').style.display = 'block';
    task.on('state_changed',
      snap => { document.getElementById('qcRectifyProgressBar').style.width = ((snap.bytesTransferred / snap.totalBytes) * 100) + '%'; },
      err => { toast('Upload failed: ' + err.message, 'err'); btn.disabled = false; btn.textContent = 'Mark Rectified'; },
      () => task.snapshot.ref.getDownloadURL().then(finish)
    );
  } else {
    finish(null);
  }
}

// --- Recheck ---
function renderQcRecheckTable(){
  const body = document.getElementById('qcRecheckTableBody');
  const items = qcObservationsData.filter(o => o.status === 'rectified');
  const badge = document.getElementById('qcRecheckBadge');
  if(badge){ badge.textContent = items.length; badge.classList.toggle('hidden', items.length === 0); }
  if(!body) return;
  if(items.length === 0){
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><b>Nothing awaiting recheck</b></div></td></tr>`;
    return;
  }
  body.innerHTML = items.map(o => `
    <tr>
      <td>${escapeHtml(o.project || '—')}</td>
      <td>${escapeHtml(o.location || '—')}${o.flat ? ` &middot; ${escapeHtml(o.flat)}` : ''}</td>
      <td style="max-width:280px;">${escapeHtml(o.observation || '—')}</td>
      <td>${o.attachmentURL ? `<a href="${o.attachmentURL}" target="_blank" rel="noopener"><img src="${o.attachmentURL}" style="width:48px; height:48px; object-fit:cover; border-radius:6px;"></a>` : '—'}</td>
      <td>${escapeHtml(o.rectifiedByName || '—')}${o.rectifiedRemarks ? `<div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">${escapeHtml(o.rectifiedRemarks)}</div>` : ''}</td>
      <td>${o.rectifiedImageURL ? `<a href="${o.rectifiedImageURL}" target="_blank" rel="noopener"><img src="${o.rectifiedImageURL}" style="width:48px; height:48px; object-fit:cover; border-radius:6px;"></a>` : '—'}</td>
      <td><button class="btn btn-teal btn-sm" onclick="openQcRecheckModal('${o.id}')">Recheck</button></td>
    </tr>`).join('');
}
function openQcRecheckModal(id){
  activeQcObservationId = id;
  document.getElementById('qcRecheckStatus').value = 'ok';
  document.getElementById('qcRecheckRemarks').value = '';
  openModal('qcRecheckModalOverlay');
}
function submitQcRecheck(){
  const id = activeQcObservationId;
  const reviewStatus = document.getElementById('qcRecheckStatus').value;
  const remarks = document.getElementById('qcRecheckRemarks').value.trim();
  const now = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('qcObservations').doc(id).update({
    status: 'rechecked', reviewStatus, recheckRemarks: remarks || null,
    recheckedBy: currentUser.uid, recheckedByName: currentUser.name, recheckedAt: now, updatedAt: now
  }).then(() => { toast('Recheck confirmed.', 'ok'); closeModal('qcRecheckModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}

// --- PH Approval ---
function renderQcPhApprovalTable(){
  const body = document.getElementById('qcPhApprovalTableBody');
  const items = qcObservationsData.filter(o => o.status === 'rechecked');
  const badge = document.getElementById('qcPhApprovalBadge');
  if(badge){ badge.textContent = items.length; badge.classList.toggle('hidden', items.length === 0); }
  if(!body) return;
  if(items.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>Nothing awaiting approval</b></div></td></tr>`;
    return;
  }
  const reviewLabel = { ok: 'Ok', done: 'Done', closed: 'Closed' };
  body.innerHTML = items.map(o => `
    <tr>
      <td>${escapeHtml(o.project || '—')}</td>
      <td>${escapeHtml(o.location || '—')}${o.flat ? ` &middot; ${escapeHtml(o.flat)}` : ''}</td>
      <td style="max-width:280px;">${escapeHtml(o.observation || '—')}</td>
      <td>${escapeHtml(reviewLabel[o.reviewStatus] || o.reviewStatus || '—')}</td>
      <td>${escapeHtml(o.recheckRemarks || '—')}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-teal btn-sm" onclick="approveQcObservation('${o.id}')">Approve</button>
        <button class="btn btn-sm" style="background:var(--red); color:#fff;" onclick="openQcPhRejectModal('${o.id}')">Reject</button>
      </td>
    </tr>`).join('');
}
function approveQcObservation(id){
  const now = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('qcObservations').doc(id).update({
    status: 'approved', phApprovedBy: currentUser.uid, phApprovedByName: currentUser.name, phApprovedAt: now, updatedAt: now
  }).then(() => toast('Observation approved.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function openQcPhRejectModal(id){
  activeQcObservationId = id;
  document.getElementById('qcPhRejectReason').value = '';
  openModal('qcPhRejectModalOverlay');
}
function submitQcPhReject(){
  const id = activeQcObservationId;
  const reason = document.getElementById('qcPhRejectReason').value.trim();
  if(!reason){ toast('Please enter a reason.', 'err'); return; }
  const item = qcObservationsData.find(o => o.id === id);
  const now = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('qcObservations').doc(id).update({
    status: 'open', rejectReason: reason, rejectCount: (item ? (item.rejectCount || 0) : 0) + 1,
    phRejectedBy: currentUser.uid, phRejectedByName: currentUser.name, phRejectedAt: now, updatedAt: now
  }).then(() => { toast('Sent back for rectification.', 'ok'); closeModal('qcPhRejectModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}



/* ============================================================
   QC CHECKLIST
   QC Activities are checklist templates (with MEP/TAT/Checklist No.
   metadata); QC Checklist Details are the individual check items under
   an Activity — reference documentation, not individually ticked off
   during an inspection. A QC Checklist Inspection logs that an Activity's
   checklist was performed at a given project/unit/location, with up to 3
   photos, then goes through a single Approve/Reject stage. The reference
   design has three sequential approval screens (SE/PH/QC) for this — this
   phase deliberately collapses them into one, like the QC Observation
   phase's role-gating simplification.
============================================================ */
let qcActivitiesData = [];
let qcActivityDetailsData = [];
let qcChecklistInspectionsData = [];
let editingQcActivityId = null;
let editingQcActivityDetailId = null;
let qcInspFilesArr = [];
let activeQcChecklistInspectionId = null;

function listenQcActivities(){
  const unsub = db.collection('qcActivityMasters').orderBy('name').onSnapshot(snap => {
    qcActivitiesData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateQcActivitySelects();
    if(currentUser && currentUser.role === 'admin') renderQcActivityTable();
    renderQcInspTable();
    renderQcChecklistApprovalTable();
  }, err => console.error('qcActivityMasters listener:', err));
  activeSessionUnsubs.push(unsub);
}
function listenQcActivityDetails(){
  const unsub = db.collection('qcActivityDetails').onSnapshot(snap => {
    qcActivityDetailsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if(currentUser && currentUser.role === 'admin') renderQcActivityDetailTable();
  }, err => console.error('qcActivityDetails listener:', err));
  activeSessionUnsubs.push(unsub);
}
function listenQcChecklistInspections(){
  const unsub = db.collection('qcChecklistInspections').orderBy('createdAt', 'desc').onSnapshot(snap => {
    qcChecklistInspectionsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderQcInspTable();
    renderQcChecklistApprovalTable();
  }, err => console.error('qcChecklistInspections listener:', err));
  activeSessionUnsubs.push(unsub);
}

function populateQcActivitySelects(){
  const optionsHtml = '<option value="">Select&hellip;</option>' +
    qcActivitiesData.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  ['qcActivityDetailActivity', 'qcInspActivity'].forEach(selId => {
    const sel = document.getElementById(selId);
    if(!sel) return;
    const prevValue = sel.value;
    sel.innerHTML = optionsHtml;
    if(qcActivitiesData.some(a => a.id === prevValue)) sel.value = prevValue;
  });
}

// --- QC Activities (admin master, multi-field so it doesn't fit the
// generic single-name MASTER_TYPES pattern — built as its own small
// inline-edit form, same shape as Manage Users) ---
function isQcActivityInUse(id){
  return qcActivityDetailsData.some(d => d.activityId === id) || qcChecklistInspectionsData.some(i => i.activityId === id);
}
function renderQcActivityTable(){
  const body = document.getElementById('qcActivityTableBody');
  if(!body) return;
  if(qcActivitiesData.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>No QC Activities yet</b></div></td></tr>`;
    return;
  }
  body.innerHTML = qcActivitiesData.map(a => {
    const inUse = isQcActivityInUse(a.id);
    return `<tr>
      <td>${escapeHtml(a.name)}</td>
      <td>${escapeHtml(a.category || '—')}</td>
      <td>${a.tat != null ? escapeHtml(String(a.tat)) : '—'}</td>
      <td>${escapeHtml(a.checklistNo || '—')}</td>
      <td>${a.mep ? 'Yes' : 'No'}</td>
      <td style="text-align:right;">
        <button class="icon-btn-sm" onclick="startQcActivityEdit('${a.id}')" title="Edit">&#9999;&#65039;</button>
        <button class="icon-btn-sm" onclick="deleteQcActivity('${a.id}')" title="${inUse ? 'In use — delete disabled' : 'Delete'}" ${inUse ? 'disabled' : ''}>&#128465;&#65039;</button>
      </td>
    </tr>`;
  }).join('');
}
function submitQcActivity(ev){
  ev.preventDefault();
  const name = document.getElementById('qcActivityName').value.trim();
  const category = document.getElementById('qcActivityCategory').value.trim();
  const tatRaw = document.getElementById('qcActivityTat').value;
  const checklistNo = document.getElementById('qcActivityChecklistNo').value.trim();
  const mep = document.getElementById('qcActivityMep').checked;
  if(!name){ toast('Please enter a name.', 'err'); return false; }
  const data = { name, category: category || 'New', tat: tatRaw ? Number(tatRaw) : null, checklistNo: checklistNo || null, mep };
  const editingId = editingQcActivityId;
  const dup = qcActivitiesData.some(a => a.id !== editingId && a.name.toLowerCase() === name.toLowerCase());
  if(dup){ toast('A QC Activity with this name already exists.', 'err'); return false; }
  const p = editingId
    ? db.collection('qcActivityMasters').doc(editingId).update(data)
    : db.collection('qcActivityMasters').add({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  p.then(() => { toast(editingId ? 'Saved.' : 'Added.', 'ok'); cancelQcActivityEdit(); })
   .catch(err => toast('Could not save: ' + err.message, 'err'));
  return false;
}
function startQcActivityEdit(id){
  const a = qcActivitiesData.find(x => x.id === id);
  if(!a) return;
  editingQcActivityId = id;
  document.getElementById('qcActivityName').value = a.name || '';
  document.getElementById('qcActivityCategory').value = a.category || 'New';
  document.getElementById('qcActivityTat').value = a.tat != null ? a.tat : '';
  document.getElementById('qcActivityChecklistNo').value = a.checklistNo || '';
  document.getElementById('qcActivityMep').checked = !!a.mep;
  document.getElementById('qcActivitySubmitBtn').textContent = 'Update';
  document.getElementById('qcActivityCancelBtn').style.display = 'inline-flex';
}
function cancelQcActivityEdit(){
  editingQcActivityId = null;
  document.getElementById('qcActivityForm').reset();
  document.getElementById('qcActivityCategory').value = 'New';
  document.getElementById('qcActivitySubmitBtn').textContent = 'Save';
  document.getElementById('qcActivityCancelBtn').style.display = 'none';
}
function deleteQcActivity(id){
  if(isQcActivityInUse(id)){ toast('This QC Activity is in use and cannot be deleted.', 'err'); return; }
  const a = qcActivitiesData.find(x => x.id === id);
  if(!confirm(`Are you sure you want to delete this QC Activity?\n\n"${a ? a.name : ''}"`)) return;
  db.collection('qcActivityMasters').doc(id).delete()
    .then(() => toast('Removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}

// --- QC Checklist Details ---
function renderQcActivityDetailTable(){
  const body = document.getElementById('qcActivityDetailTableBody');
  if(!body) return;
  if(qcActivityDetailsData.length === 0){
    body.innerHTML = `<tr><td colspan="3"><div class="empty-state"><b>No checklist details yet</b></div></td></tr>`;
    return;
  }
  body.innerHTML = qcActivityDetailsData.map(d => {
    const activity = qcActivitiesData.find(a => a.id === d.activityId);
    return `<tr>
      <td>${escapeHtml(activity ? activity.name : '—')}</td>
      <td>${escapeHtml(d.detail)}</td>
      <td style="text-align:right;">
        <button class="icon-btn-sm" onclick="startQcActivityDetailEdit('${d.id}')" title="Edit">&#9999;&#65039;</button>
        <button class="icon-btn-sm" onclick="deleteQcActivityDetail('${d.id}')" title="Delete">&#128465;&#65039;</button>
      </td>
    </tr>`;
  }).join('');
}
function submitQcActivityDetail(ev){
  ev.preventDefault();
  const activityId = document.getElementById('qcActivityDetailActivity').value;
  const detail = document.getElementById('qcActivityDetailText').value.trim();
  if(!activityId || !detail){ toast('Please choose a QC Activity and enter a detail.', 'err'); return false; }
  const editingId = editingQcActivityDetailId;
  const p = editingId
    ? db.collection('qcActivityDetails').doc(editingId).update({ activityId, detail })
    : db.collection('qcActivityDetails').add({ activityId, detail, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  p.then(() => { toast(editingId ? 'Saved.' : 'Added.', 'ok'); cancelQcActivityDetailEdit(); })
   .catch(err => toast('Could not save: ' + err.message, 'err'));
  return false;
}
function startQcActivityDetailEdit(id){
  const d = qcActivityDetailsData.find(x => x.id === id);
  if(!d) return;
  editingQcActivityDetailId = id;
  document.getElementById('qcActivityDetailActivity').value = d.activityId;
  document.getElementById('qcActivityDetailText').value = d.detail;
  document.getElementById('qcActivityDetailSubmitBtn').textContent = 'Update';
  document.getElementById('qcActivityDetailCancelBtn').style.display = 'inline-flex';
}
function cancelQcActivityDetailEdit(){
  editingQcActivityDetailId = null;
  document.getElementById('qcActivityDetailForm').reset();
  document.getElementById('qcActivityDetailSubmitBtn').textContent = 'Save';
  document.getElementById('qcActivityDetailCancelBtn').style.display = 'none';
}
function deleteQcActivityDetail(id){
  if(!confirm('Are you sure you want to delete this checklist detail?')) return;
  db.collection('qcActivityDetails').doc(id).delete()
    .then(() => toast('Removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}

// --- QC Checklist Inspection ---
(function wireQcInspDropzone(){
  const dz = document.getElementById('qcInspDropzone');
  const fi = document.getElementById('qcInspFiles');
  if(!dz || !fi) return;
  function addFiles(fileList){
    Array.from(fileList).forEach(f => { if(qcInspFilesArr.length < 3) qcInspFilesArr.push(f); });
    document.getElementById('qcInspFilePillWrap').innerHTML = qcInspFilesArr.map(f => `<div class="file-pill">${escapeHtml(f.name)}</div>`).join('');
  }
  fi.addEventListener('change', () => addFiles(fi.files));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); if(e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  const dateInput = document.getElementById('qcInspDate');
  if(dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
})();

function handleQcInspectionSubmit(ev){
  ev.preventDefault();
  const activityId = document.getElementById('qcInspActivity').value;
  const activity = qcActivitiesData.find(a => a.id === activityId);
  const meta = {
    project: document.getElementById('qcInspProject').value,
    projectType: document.getElementById('qcInspProjectType').value.trim(),
    unitNo: document.getElementById('qcInspUnitNo').value.trim(),
    location: document.getElementById('qcInspLocation').value.trim(),
    drawingDetails: document.getElementById('qcInspDrawingDetails').value.trim(),
    contractorName: document.getElementById('qcInspContractor').value.trim(),
    activityId, activityName: activity ? activity.name : '',
    startDate: document.getElementById('qcInspDate').value
  };
  if(!meta.project || !meta.unitNo || !meta.location || !meta.drawingDetails || !meta.activityId){
    toast('Please fill in all required fields.', 'err');
    return false;
  }
  const btn = document.getElementById('qcInspSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const files = qcInspFilesArr.slice(0, 3);

  const finish = (images) => {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    db.collection('qcChecklistInspections').add({
      ...meta, images, status: 'pending',
      inspectedBy: currentUser.uid, inspectedByName: currentUser.name,
      createdAt: now, updatedAt: now
    }).then(() => {
      toast('Inspection logged.', 'ok');
      document.getElementById('qcInspForm').reset();
      qcInspFilesArr = [];
      document.getElementById('qcInspFilePillWrap').innerHTML = '';
      document.getElementById('qcInspDate').value = new Date().toISOString().slice(0, 10);
    }).catch(err => toast('Could not save: ' + err.message, 'err'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Save'; document.getElementById('qcInspProgressWrap').style.display = 'none'; });
  };

  function uploadNext(idx, images){
    if(idx >= files.length) return finish(images);
    const f = files[idx];
    const path = `qcChecklistInspections/${Date.now()}_${idx}_${f.name}`;
    document.getElementById('qcInspProgressWrap').style.display = 'block';
    const task = storage.ref(path).put(f);
    task.on('state_changed',
      snap => { document.getElementById('qcInspProgressBar').style.width = ((snap.bytesTransferred / snap.totalBytes) * 100) + '%'; },
      err => { toast('Upload failed: ' + err.message, 'err'); btn.disabled = false; btn.textContent = 'Save'; },
      () => task.snapshot.ref.getDownloadURL().then(url => uploadNext(idx + 1, [...images, url]))
    );
  }
  if(files.length) uploadNext(0, []); else finish([]);
  return false;
}

function renderQcInspTable(){
  const body = document.getElementById('qcInspTableBody');
  if(!body) return;
  if(qcChecklistInspectionsData.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>No inspections logged yet</b></div></td></tr>`;
    return;
  }
  const statusMap = { pending: 'st-pending_review', approved: 'st-published', rejected: 'st-rejected' };
  const statusLabel = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };
  body.innerHTML = qcChecklistInspectionsData.map(i => `
    <tr>
      <td>${escapeHtml(i.project || '—')}</td>
      <td>${escapeHtml(i.unitNo || '—')} &middot; ${escapeHtml(i.location || '—')}</td>
      <td>${escapeHtml(i.activityName || '—')}</td>
      <td>${escapeHtml(i.startDate || '—')}</td>
      <td>${escapeHtml(i.inspectedByName || '—')}</td>
      <td><span class="badge ${statusMap[i.status] || ''}"><span class="dot"></span>${statusLabel[i.status] || i.status}</span></td>
    </tr>`).join('');
}

// --- QC Checklist Approval ---
function renderQcChecklistApprovalTable(){
  const body = document.getElementById('qcChecklistApprovalTableBody');
  const items = qcChecklistInspectionsData.filter(i => i.status === 'pending');
  const badge = document.getElementById('qcChecklistApprovalBadge');
  if(badge){ badge.textContent = items.length; badge.classList.toggle('hidden', items.length === 0); }
  if(!body) return;
  if(items.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>Nothing awaiting approval</b></div></td></tr>`;
    return;
  }
  body.innerHTML = items.map(i => `
    <tr>
      <td>${escapeHtml(i.project || '—')}</td>
      <td>${escapeHtml(i.unitNo || '—')} &middot; ${escapeHtml(i.location || '—')}</td>
      <td>${escapeHtml(i.activityName || '—')}</td>
      <td>${(i.images || []).map(url => `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" style="width:40px; height:40px; object-fit:cover; border-radius:5px; margin-right:4px;"></a>`).join('') || '—'}</td>
      <td>${escapeHtml(i.inspectedByName || '—')}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-teal btn-sm" onclick="approveQcChecklistInspection('${i.id}')">Approve</button>
        <button class="btn btn-sm" style="background:var(--red); color:#fff;" onclick="openQcChecklistRejectModal('${i.id}')">Reject</button>
      </td>
    </tr>`).join('');
}
function approveQcChecklistInspection(id){
  const now = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('qcChecklistInspections').doc(id).update({
    status: 'approved', approvedBy: currentUser.uid, approvedByName: currentUser.name, approvedAt: now, updatedAt: now
  }).then(() => toast('Inspection approved.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function openQcChecklistRejectModal(id){
  activeQcChecklistInspectionId = id;
  document.getElementById('qcChecklistRejectReason').value = '';
  openModal('qcChecklistRejectModalOverlay');
}
function submitQcChecklistReject(){
  const id = activeQcChecklistInspectionId;
  const reason = document.getElementById('qcChecklistRejectReason').value.trim();
  if(!reason){ toast('Please enter a reason.', 'err'); return; }
  const now = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('qcChecklistInspections').doc(id).update({
    status: 'rejected', rejectReason: reason, rejectedBy: currentUser.uid, rejectedByName: currentUser.name, rejectedAt: now, updatedAt: now
  }).then(() => { toast('Inspection rejected.', 'ok'); closeModal('qcChecklistRejectModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}

/* ============================================================
   MATERIAL TESTING
   Materials is a plain MASTER_TYPES entry (reuses the generic CRUD).
   Material Testing Details is a one-to-many list (Material -> its test
   types, e.g. "Compressive Strength" for Solid Block) — same bespoke
   inline-edit pattern as QC Checklist Details. Material Testing Log
   entries record an actual test result with up to 3 photos; the Report
   page filters the same data by project/material/date range.
============================================================ */
let materialTestDetailsData = [];
let materialTestLogsData = [];
let editingMaterialTestDetailId = null;
let matLogFilesArr = [];

function listenMaterialTestDetails(){
  const unsub = db.collection('materialTestDetails').onSnapshot(snap => {
    materialTestDetailsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if(currentUser && currentUser.role === 'admin') renderMaterialTestDetailTable();
    refreshMasterDataPanels(); // Material "in use" status depends on this data
  }, err => console.error('materialTestDetails listener:', err));
  activeSessionUnsubs.push(unsub);
}
function listenMaterialTestLogs(){
  const unsub = db.collection('materialTestLogs').orderBy('createdAt', 'desc').onSnapshot(snap => {
    materialTestLogsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMatLogTable();
    renderMaterialTestReportTable();
    refreshMasterDataPanels();
  }, err => console.error('materialTestLogs listener:', err));
  activeSessionUnsubs.push(unsub);
}

// Populates a Test Details <select> based on whichever Material is chosen
// in a paired <select> — used by the Material Testing log form.
function populateMaterialTestDetailSelectFor(materialSelectId, detailSelectId){
  const materialId = document.getElementById(materialSelectId).value;
  const sel = document.getElementById(detailSelectId);
  if(!sel) return;
  const matching = materialTestDetailsData.filter(d => d.materialId === materialId);
  sel.innerHTML = matching.length
    ? '<option value="">Select&hellip;</option>' + matching.map(d => `<option value="${d.id}">${escapeHtml(d.testDetail)}</option>`).join('')
    : '<option value="">No test details set up for this material</option>';
}

// --- Material Testing Details (admin) ---
function renderMaterialTestDetailTable(){
  const body = document.getElementById('materialTestDetailTableBody');
  if(!body) return;
  if(materialTestDetailsData.length === 0){
    body.innerHTML = `<tr><td colspan="3"><div class="empty-state"><b>No test details yet</b></div></td></tr>`;
    return;
  }
  body.innerHTML = materialTestDetailsData.map(d => {
    const material = mastersData.materialMasters.find(m => m.id === d.materialId);
    return `<tr>
      <td>${escapeHtml(material ? material.name : '—')}</td>
      <td>${escapeHtml(d.testDetail)}</td>
      <td style="text-align:right;">
        <button class="icon-btn-sm" onclick="startMaterialTestDetailEdit('${d.id}')" title="Edit">&#9999;&#65039;</button>
        <button class="icon-btn-sm" onclick="deleteMaterialTestDetail('${d.id}')" title="Delete">&#128465;&#65039;</button>
      </td>
    </tr>`;
  }).join('');
}
function submitMaterialTestDetail(ev){
  ev.preventDefault();
  const materialId = document.getElementById('materialTestDetailMaterial').value;
  const testDetail = document.getElementById('materialTestDetailText').value.trim();
  if(!materialId || !testDetail){ toast('Please choose a material and enter a test detail.', 'err'); return false; }
  const editingId = editingMaterialTestDetailId;
  const p = editingId
    ? db.collection('materialTestDetails').doc(editingId).update({ materialId, testDetail })
    : db.collection('materialTestDetails').add({ materialId, testDetail, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  p.then(() => { toast(editingId ? 'Saved.' : 'Added.', 'ok'); cancelMaterialTestDetailEdit(); })
   .catch(err => toast('Could not save: ' + err.message, 'err'));
  return false;
}
function startMaterialTestDetailEdit(id){
  const d = materialTestDetailsData.find(x => x.id === id);
  if(!d) return;
  editingMaterialTestDetailId = id;
  document.getElementById('materialTestDetailMaterial').value = d.materialId;
  document.getElementById('materialTestDetailText').value = d.testDetail;
  document.getElementById('materialTestDetailSubmitBtn').textContent = 'Update';
  document.getElementById('materialTestDetailCancelBtn').style.display = 'inline-flex';
}
function cancelMaterialTestDetailEdit(){
  editingMaterialTestDetailId = null;
  document.getElementById('materialTestDetailForm').reset();
  document.getElementById('materialTestDetailSubmitBtn').textContent = 'Save';
  document.getElementById('materialTestDetailCancelBtn').style.display = 'none';
}
function deleteMaterialTestDetail(id){
  if(!confirm('Are you sure you want to delete this test detail?')) return;
  db.collection('materialTestDetails').doc(id).delete()
    .then(() => toast('Removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}

// --- Material Testing Log ---
(function wireMatLogDropzone(){
  const dz = document.getElementById('matLogDropzone');
  const fi = document.getElementById('matLogFiles');
  if(!dz || !fi) return;
  function addFiles(fileList){
    Array.from(fileList).forEach(f => { if(matLogFilesArr.length < 3) matLogFilesArr.push(f); });
    document.getElementById('matLogFilePillWrap').innerHTML = matLogFilesArr.map(f => `<div class="file-pill">${escapeHtml(f.name)}</div>`).join('');
  }
  fi.addEventListener('change', () => addFiles(fi.files));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); if(e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
})();

function handleMaterialTestLogSubmit(ev){
  ev.preventDefault();
  const materialId = document.getElementById('matLogMaterial').value;
  const testDetailId = document.getElementById('matLogTestDetail').value;
  const material = mastersData.materialMasters.find(m => m.id === materialId);
  const testDetail = materialTestDetailsData.find(d => d.id === testDetailId);
  const meta = {
    project: document.getElementById('matLogProject').value,
    location: document.getElementById('matLogLocation').value.trim(),
    materialId, materialName: material ? material.name : '',
    testDetailId, testDetailName: testDetail ? testDetail.testDetail : '',
    remarks: document.getElementById('matLogRemarks').value.trim()
  };
  if(!meta.project || !meta.materialId || !meta.testDetailId){
    toast('Please fill in all required fields.', 'err');
    return false;
  }
  const btn = document.getElementById('matLogSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const files = matLogFilesArr.slice(0, 3);

  const finish = (images) => {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    db.collection('materialTestLogs').add({
      ...meta, images,
      createdBy: currentUser.uid, createdByName: currentUser.name,
      createdAt: now, updatedAt: now
    }).then(() => {
      toast('Test result logged.', 'ok');
      document.getElementById('matLogForm').reset();
      matLogFilesArr = [];
      document.getElementById('matLogFilePillWrap').innerHTML = '';
      document.getElementById('matLogTestDetail').innerHTML = '<option value="">Select material first&hellip;</option>';
    }).catch(err => toast('Could not save: ' + err.message, 'err'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Save'; document.getElementById('matLogProgressWrap').style.display = 'none'; });
  };

  function uploadNext(idx, images){
    if(idx >= files.length) return finish(images);
    const f = files[idx];
    const path = `materialTestLogs/${Date.now()}_${idx}_${f.name}`;
    document.getElementById('matLogProgressWrap').style.display = 'block';
    const task = storage.ref(path).put(f);
    task.on('state_changed',
      snap => { document.getElementById('matLogProgressBar').style.width = ((snap.bytesTransferred / snap.totalBytes) * 100) + '%'; },
      err => { toast('Upload failed: ' + err.message, 'err'); btn.disabled = false; btn.textContent = 'Save'; },
      () => task.snapshot.ref.getDownloadURL().then(url => uploadNext(idx + 1, [...images, url]))
    );
  }
  if(files.length) uploadNext(0, []); else finish([]);
  return false;
}

function renderMatLogTable(){
  const body = document.getElementById('matLogTableBody');
  if(!body) return;
  if(materialTestLogsData.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>No test results logged yet</b></div></td></tr>`;
    return;
  }
  body.innerHTML = materialTestLogsData.map(l => `
    <tr>
      <td>${escapeHtml(l.project || '—')}</td>
      <td>${escapeHtml(l.location || '—')}</td>
      <td>${timeAgo(l.createdAt)}</td>
      <td>${escapeHtml(l.materialName || '—')}</td>
      <td>${escapeHtml(l.testDetailName || '—')}</td>
      <td>${escapeHtml(l.remarks || '—')}</td>
    </tr>`).join('');
}

// --- Material Testing Report ---
function renderMaterialTestReportTable(){
  const body = document.getElementById('matRptTableBody');
  if(!body) return;
  const project = document.getElementById('matRptProject') ? document.getElementById('matRptProject').value : '';
  const materialId = document.getElementById('matRptMaterial') ? document.getElementById('matRptMaterial').value : '';
  const fromDate = document.getElementById('matRptFrom') ? document.getElementById('matRptFrom').value : '';
  const toDate = document.getElementById('matRptTo') ? document.getElementById('matRptTo').value : '';

  const filtered = materialTestLogsData.filter(l => {
    if(project && l.project !== project) return false;
    if(materialId && l.materialId !== materialId) return false;
    if((fromDate || toDate) && l.createdAt && l.createdAt.toMillis){
      const ms = l.createdAt.toMillis();
      if(fromDate && ms < new Date(fromDate).getTime()) return false;
      if(toDate && ms > new Date(toDate).getTime() + 86400000) return false;
    }
    return true;
  });

  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><b>No results match these filters</b></div></td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(l => `
    <tr>
      <td>${escapeHtml(l.project || '—')}</td>
      <td>${escapeHtml(l.location || '—')}</td>
      <td>${timeAgo(l.createdAt)}</td>
      <td>${escapeHtml(l.materialName || '—')}</td>
      <td>${escapeHtml(l.testDetailName || '—')}</td>
      <td>${escapeHtml(l.remarks || '—')}</td>
      <td>${escapeHtml(l.createdByName || '—')}</td>
    </tr>`).join('');
}
function clearMaterialTestReportFilters(){
  ['matRptProject','matRptMaterial'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  ['matRptFrom','matRptTo'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  renderMaterialTestReportTable();
}

/* ============================================================
   FINAL SNAG POINT
   A simpler model than QC Observation: rather than separate Rectify/
   Recheck/PH-Approval pages, Rectified and QC Approved are two flags
   toggled directly on the record via its Edit modal — the reference
   report's "Rectified"/"QC Approval" count columns are the only signal
   of a multi-stage flow, and no separate action screens were shown for
   it, so this collapses cleanly rather than inventing pages unseen.
   Site Engineer / Project Manager are plain selects over all users
   (not filtered by role) to keep this independent of exact role naming.
============================================================ */
let finalSnagPointsData = [];
let snagFile = null;
let activeSnagId = null;

function listenFinalSnagPoints(){
  const unsub = db.collection('finalSnagPoints').orderBy('createdAt', 'desc').onSnapshot(snap => {
    finalSnagPointsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSnagTable();
    renderSnagReportTable();
  }, err => console.error('finalSnagPoints listener:', err));
  activeSessionUnsubs.push(unsub);
}

function populateSnagUserSelects(){
  const optionsHtml = '<option value="">Select&hellip;</option>' +
    usersData.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  ['snagSiteEngineer', 'snagProjectManager', 'editSnagSiteEngineer', 'editSnagProjectManager'].forEach(selId => {
    const sel = document.getElementById(selId);
    if(!sel) return;
    const prevValue = sel.value;
    sel.innerHTML = optionsHtml;
    if(usersData.some(u => u.id === prevValue)) sel.value = prevValue;
  });
}

// --- Log Snag form ---
(function wireSnagDropzone(){
  const dz = document.getElementById('snagDropzone');
  const fi = document.getElementById('snagFile');
  if(!dz || !fi) return;
  fi.addEventListener('change', () => {
    snagFile = fi.files[0] || null;
    document.getElementById('snagFilePillWrap').innerHTML = snagFile ? `<div class="file-pill">${escapeHtml(snagFile.name)}</div>` : '';
  });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    if(e.dataTransfer.files[0]){ fi.files = e.dataTransfer.files; snagFile = e.dataTransfer.files[0]; document.getElementById('snagFilePillWrap').innerHTML = `<div class="file-pill">${escapeHtml(snagFile.name)}</div>`; }
  });
})();

function handleSnagSubmit(ev){
  ev.preventDefault();
  const siteEngineerUid = document.getElementById('snagSiteEngineer').value;
  const projectManagerUid = document.getElementById('snagProjectManager').value;
  const siteEngineerUser = usersData.find(u => u.id === siteEngineerUid);
  const projectManagerUser = usersData.find(u => u.id === projectManagerUid);
  const meta = {
    project: document.getElementById('snagProject').value,
    flat: document.getElementById('snagFlat').value.trim(),
    siteEngineerUid, siteEngineerName: siteEngineerUser ? siteEngineerUser.name : '',
    projectManagerUid, projectManagerName: projectManagerUser ? projectManagerUser.name : '',
    snagPoint: document.getElementById('snagText').value.trim()
  };
  if(!meta.project || !meta.flat || !meta.snagPoint){
    toast('Please fill in all required fields.', 'err');
    return false;
  }
  const btn = document.getElementById('snagSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const finish = (fileURL) => {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    db.collection('finalSnagPoints').add({
      ...meta, fileURL: fileURL || null, rectified: false, qcApproved: false,
      createdBy: currentUser.uid, createdByName: currentUser.name,
      createdAt: now, updatedAt: now
    }).then(() => {
      toast('Snag point added.', 'ok');
      document.getElementById('snagForm').reset();
      snagFile = null;
      document.getElementById('snagFilePillWrap').innerHTML = '';
    }).catch(err => toast('Could not save: ' + err.message, 'err'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Add'; document.getElementById('snagProgressWrap').style.display = 'none'; });
  };

  if(snagFile){
    const path = `finalSnagPoints/${Date.now()}_${snagFile.name}`;
    const task = storage.ref(path).put(snagFile);
    document.getElementById('snagProgressWrap').style.display = 'block';
    task.on('state_changed',
      snap => { document.getElementById('snagProgressBar').style.width = ((snap.bytesTransferred / snap.totalBytes) * 100) + '%'; },
      err => { toast('Upload failed: ' + err.message, 'err'); btn.disabled = false; btn.textContent = 'Add'; },
      () => task.snapshot.ref.getDownloadURL().then(finish)
    );
  } else {
    finish(null);
  }
  return false;
}

function snagStatusBadge(s){
  if(s.qcApproved) return `<span class="badge st-published"><span class="dot"></span>QC Approved</span>`;
  if(s.rectified) return `<span class="badge st-approved"><span class="dot"></span>Rectified</span>`;
  return `<span class="badge st-pending_review"><span class="dot"></span>Open</span>`;
}

function renderSnagTable(){
  const body = document.getElementById('snagTableBody');
  if(!body) return;
  if(finalSnagPointsData.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>No snag points logged yet</b></div></td></tr>`;
    return;
  }
  body.innerHTML = finalSnagPointsData.map(s => `
    <tr onclick="openEditSnagModal('${s.id}')">
      <td>${escapeHtml(s.project || '—')}</td>
      <td>${escapeHtml(s.flat || '—')}</td>
      <td>${escapeHtml(s.siteEngineerName || '—')}</td>
      <td>${escapeHtml(s.projectManagerName || '—')}</td>
      <td>${snagStatusBadge(s)}</td>
      <td style="text-align:right;"><button class="icon-btn-sm" onclick="event.stopPropagation(); openEditSnagModal('${s.id}')" title="Open">&#9999;&#65039;</button></td>
    </tr>`).join('');
}

function openEditSnagModal(id){
  const s = finalSnagPointsData.find(x => x.id === id);
  if(!s) return;
  activeSnagId = id;
  populateSnagUserSelects();
  document.getElementById('editSnagProject').value = s.project || '';
  document.getElementById('editSnagFlat').value = s.flat || '';
  document.getElementById('editSnagSiteEngineer').value = s.siteEngineerUid || '';
  document.getElementById('editSnagProjectManager').value = s.projectManagerUid || '';
  document.getElementById('editSnagText').value = s.snagPoint || '';
  document.getElementById('editSnagRectified').checked = !!s.rectified;
  document.getElementById('editSnagQcApproved').checked = !!s.qcApproved;
  document.getElementById('editSnagFileFieldWrap').innerHTML = s.fileURL
    ? `<label>Attachment</label><a href="${s.fileURL}" target="_blank" rel="noopener">View attached file</a>`
    : '';
  openModal('editSnagModalOverlay');
}
function submitEditSnag(){
  const id = activeSnagId;
  const siteEngineerUid = document.getElementById('editSnagSiteEngineer').value;
  const projectManagerUid = document.getElementById('editSnagProjectManager').value;
  const siteEngineerUser = usersData.find(u => u.id === siteEngineerUid);
  const projectManagerUser = usersData.find(u => u.id === projectManagerUid);
  const updates = {
    project: document.getElementById('editSnagProject').value,
    flat: document.getElementById('editSnagFlat').value.trim(),
    siteEngineerUid, siteEngineerName: siteEngineerUser ? siteEngineerUser.name : '',
    projectManagerUid, projectManagerName: projectManagerUser ? projectManagerUser.name : '',
    snagPoint: document.getElementById('editSnagText').value.trim(),
    rectified: document.getElementById('editSnagRectified').checked,
    qcApproved: document.getElementById('editSnagQcApproved').checked,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if(!updates.project || !updates.flat || !updates.snagPoint){ toast('Please fill in all required fields.', 'err'); return; }
  db.collection('finalSnagPoints').doc(id).update(updates)
    .then(() => { toast('Saved.', 'ok'); closeModal('editSnagModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function deleteSnag(){
  const id = activeSnagId;
  const s = finalSnagPointsData.find(x => x.id === id);
  if(!confirm(`Are you sure you want to delete this snag point?\n\n"${s ? s.snagPoint : ''}"`)) return;
  db.collection('finalSnagPoints').doc(id).delete()
    .then(() => { toast('Removed.', 'ok'); closeModal('editSnagModalOverlay'); })
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}

// --- Final Snag Point Report ---
function renderSnagReportTable(){
  const body = document.getElementById('snagRptTableBody');
  if(!body) return;
  const projectFilter = document.getElementById('snagRptProject') ? document.getElementById('snagRptProject').value : '';
  const filtered = projectFilter ? finalSnagPointsData.filter(s => s.project === projectFilter) : finalSnagPointsData;
  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="4"><div class="empty-state"><b>No snag points match these filters</b></div></td></tr>`;
    return;
  }
  const byProject = {};
  filtered.forEach(s => {
    const key = s.project || '—';
    if(!byProject[key]) byProject[key] = { total: 0, rectified: 0, qcApproved: 0 };
    byProject[key].total++;
    if(s.rectified) byProject[key].rectified++;
    if(s.qcApproved) byProject[key].qcApproved++;
  });
  body.innerHTML = Object.keys(byProject).sort().map(p => `
    <tr>
      <td>${escapeHtml(p)}</td>
      <td>${byProject[p].total}</td>
      <td>${byProject[p].rectified}</td>
      <td>${byProject[p].qcApproved}</td>
    </tr>`).join('');
}
function clearSnagReportFilters(){
  const el = document.getElementById('snagRptProject');
  if(el) el.value = '';
  renderSnagReportTable();
}

/* ============================================================
   GOOD QUALITY WORK
============================================================ */
function listenGoodWork(){
  const unsub = db.collection('goodQualityWork').orderBy('createdAt', 'desc').onSnapshot(snap => {
    goodWorkData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderGoodWorkTable();
    renderGoodWorkReportTable();
  }, err => console.error('goodQualityWork listener:', err));
  activeSessionUnsubs.push(unsub);
}

function handleGoodWorkSubmit(ev){
  ev.preventDefault();
  const meta = {
    project: document.getElementById('goodWorkProject').value,
    location: document.getElementById('goodWorkLocation').value.trim(),
    remarks: document.getElementById('goodWorkRemarks').value.trim()
  };
  if(!meta.project){ toast('Please choose a project.', 'err'); return false; }
  const btn = document.getElementById('goodWorkSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const files = ['goodWorkFile1', 'goodWorkFile2', 'goodWorkFile3']
    .map(id => document.getElementById(id).files[0])
    .filter(Boolean);
  const finish = (images) => {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    db.collection('goodQualityWork').add({
      ...meta, images,
      createdBy: currentUser.uid, createdByName: currentUser.name,
      createdAt: now, updatedAt: now
    }).then(() => { toast('Saved.', 'ok'); document.getElementById('goodWorkForm').reset(); })
      .catch(err => toast('Could not save: ' + err.message, 'err'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Save'; document.getElementById('goodWorkProgressWrap').style.display = 'none'; });
  };
  function uploadNext(idx, images){
    if(idx >= files.length) return finish(images);
    const f = files[idx];
    const path = `goodQualityWork/${Date.now()}_${idx}_${f.name}`;
    document.getElementById('goodWorkProgressWrap').style.display = 'block';
    const task = storage.ref(path).put(f);
    task.on('state_changed',
      snap => { document.getElementById('goodWorkProgressBar').style.width = ((snap.bytesTransferred / snap.totalBytes) * 100) + '%'; },
      err => { toast('Upload failed: ' + err.message, 'err'); btn.disabled = false; btn.textContent = 'Save'; },
      () => task.snapshot.ref.getDownloadURL().then(url => uploadNext(idx + 1, [...images, url]))
    );
  }
  if(files.length) uploadNext(0, []); else finish([]);
  return false;
}
function goodWorkPhotoThumbs(images){
  return (images || []).map(url => `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" style="width:36px; height:36px; object-fit:cover; border-radius:5px; margin-right:4px;"></a>`).join('') || '—';
}
function renderGoodWorkTable(){
  const body = document.getElementById('goodWorkTableBody');
  if(!body) return;
  if(goodWorkData.length === 0){ body.innerHTML = `<tr><td colspan="5"><div class="empty-state"><b>Nothing logged yet</b></div></td></tr>`; return; }
  body.innerHTML = goodWorkData.map(g => `
    <tr onclick="openEditGoodWorkModal('${g.id}')">
      <td>${escapeHtml(g.project || '—')}</td>
      <td>${escapeHtml(g.location || '—')}</td>
      <td>${escapeHtml(g.remarks || '—')}</td>
      <td>${goodWorkPhotoThumbs(g.images)}</td>
      <td style="text-align:right;"><button class="icon-btn-sm" onclick="event.stopPropagation(); openEditGoodWorkModal('${g.id}')" title="Edit">&#9999;&#65039;</button></td>
    </tr>`).join('');
}
function openEditGoodWorkModal(id){
  const g = goodWorkData.find(x => x.id === id);
  if(!g) return;
  activeGoodWorkId = id;
  document.getElementById('editGoodWorkProject').value = g.project || '';
  document.getElementById('editGoodWorkLocation').value = g.location || '';
  document.getElementById('editGoodWorkRemarks').value = g.remarks || '';
  document.getElementById('editGoodWorkPhotosWrap').innerHTML = (g.images && g.images.length)
    ? `<label>Photos</label><div>${goodWorkPhotoThumbs(g.images)}</div>` : '';
  openModal('editGoodWorkModalOverlay');
}
function submitEditGoodWork(){
  const id = activeGoodWorkId;
  const updates = {
    project: document.getElementById('editGoodWorkProject').value,
    location: document.getElementById('editGoodWorkLocation').value.trim(),
    remarks: document.getElementById('editGoodWorkRemarks').value.trim(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if(!updates.project){ toast('Please choose a project.', 'err'); return; }
  db.collection('goodQualityWork').doc(id).update(updates)
    .then(() => { toast('Saved.', 'ok'); closeModal('editGoodWorkModalOverlay'); })
    .catch(err => toast('Could not save: ' + err.message, 'err'));
}
function deleteGoodWork(){
  const id = activeGoodWorkId;
  if(!confirm('Are you sure you want to delete this entry?')) return;
  db.collection('goodQualityWork').doc(id).delete()
    .then(() => { toast('Removed.', 'ok'); closeModal('editGoodWorkModalOverlay'); })
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}
function renderGoodWorkReportTable(){
  const body = document.getElementById('goodWorkRptTableBody');
  if(!body) return;
  const project = document.getElementById('goodWorkRptProject') ? document.getElementById('goodWorkRptProject').value : '';
  const fromDate = document.getElementById('goodWorkRptFrom') ? document.getElementById('goodWorkRptFrom').value : '';
  const toDate = document.getElementById('goodWorkRptTo') ? document.getElementById('goodWorkRptTo').value : '';
  const filtered = goodWorkData.filter(g => {
    if(project && g.project !== project) return false;
    if((fromDate || toDate) && g.createdAt && g.createdAt.toMillis){
      const ms = g.createdAt.toMillis();
      if(fromDate && ms < new Date(fromDate).getTime()) return false;
      if(toDate && ms > new Date(toDate).getTime() + 86400000) return false;
    }
    return true;
  });
  if(filtered.length === 0){ body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>No entries match these filters</b></div></td></tr>`; return; }
  body.innerHTML = filtered.map(g => `
    <tr>
      <td>${timeAgo(g.createdAt)}</td>
      <td>${escapeHtml(g.project || '—')}</td>
      <td>${escapeHtml(g.location || '—')}</td>
      <td>${escapeHtml(g.remarks || '—')}</td>
      <td>${escapeHtml(g.createdByName || '—')}</td>
      <td>${goodWorkPhotoThumbs(g.images)}</td>
    </tr>`).join('');
}
function clearGoodWorkReportFilters(){
  ['goodWorkRptProject','goodWorkRptFrom','goodWorkRptTo'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  renderGoodWorkReportTable();
}

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
    const fallback = PAGE_ACCESS_ITEMS.find(i => canAccessPage(i.key));
    switchView(fallback ? fallback.key : 'uploadView');
  }
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
        ${projectCheckboxes || '<div class="master-empty">No projects in Manage Projects yet.</div>'}
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
  listenQcWorkflowConfigs();
  listenStatusLabels();
  listenRoleMasters();
  listenQcObservations();
  listenQcActivities();
  listenQcActivityDetails();
  listenQcChecklistInspections();
  listenMaterialTestDetails();
  listenMaterialTestLogs();
  listenFinalSnagPoints();
  listenGoodWork();
  listenProjectStaffing();
  listenPageAccess();
  listenUserPageAccess();
  listenUsers(); // needed by everyone now, not just admins — populates Site Engineer/Project Manager selects for Final Snag Point
  refreshMasterDataPanels(); // in case this admin's panels were open before this fired
}

function stopSessionListeners(){
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
  qcWorkflowConfigStepsData = [];
  activeQcWorkflowCategory = null;
  activeWfModule = 'dms';
  customStatusesData = [];
  editingCustomStatusId = null;
  qcObservationsData = [];
  qcObsFile = null;
  qcRectifyFile = null;
  activeQcObservationId = null;
  qcActivitiesData = [];
  qcActivityDetailsData = [];
  qcChecklistInspectionsData = [];
  editingQcActivityId = null;
  editingQcActivityDetailId = null;
  qcInspFilesArr = [];
  activeQcChecklistInspectionId = null;
  materialTestDetailsData = [];
  materialTestLogsData = [];
  editingMaterialTestDetailId = null;
  matLogFilesArr = [];
  finalSnagPointsData = [];
  snagFile = null;
  activeSnagId = null;
  pageAccessData = {};
  userPageAccessData = {};
  goodWorkData = [];
  activeGoodWorkId = null;
  projectStaffingData = {};
  STATUS_LABELS = { ...DEFAULT_STATUS_LABELS };
  ROLE_LABELS = { ...DEFAULT_ROLE_LABELS };
}

listenMasters(); // public read — populate registration + upload dropdowns even before sign-in
