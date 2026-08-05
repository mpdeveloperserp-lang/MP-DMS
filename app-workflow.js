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
  const unsub1 = db.collection('notifications').where('forRole','==',currentUser.role).orderBy('createdAt','desc').limit(30)
    .onSnapshot(snap => { snap.docChanges().forEach(upsertNotif); renderNotifications(); },
      err => console.error('notif(role) listener:', err));
  const unsub2 = db.collection('notifications').where('toUid','==',currentUser.uid).orderBy('createdAt','desc').limit(30)
    .onSnapshot(snap => { snap.docChanges().forEach(upsertNotif); renderNotifications(); },
      err => console.error('notif(uid) listener:', err));
  activeSessionUnsubs.push(unsub1, unsub2);
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
  let mine = Array.from(queueMap.values()).filter(v =>
    (v.steps||[]).some(s => s.stage === v.currentStage && s.decision === 'pending' && (s.role === currentUser.role || currentUser.role === 'admin'))
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
    list.innerHTML = queueShowOverdueOnly
      ? `<div class="empty-state"><div class="ic">&#9989;</div><b>Nothing overdue</b><div>None of your pending items are over 2 days old. <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="toggleOverdueOnly()">Show all</button></div></div>`
      : `<div class="empty-state"><div class="ic">&#9989;</div><b>Queue clear</b><div>Nothing is waiting on your ${escapeHtml(ROLE_LABELS[currentUser.role]||'')} approval right now.</div></div>`;
    return;
  }
  list.innerHTML = mine.map(v => {
    const myStep = v.steps.find(s => s.stage === v.currentStage && s.decision === 'pending' && (s.role === currentUser.role || currentUser.role === 'admin'));
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

  const stepRows = latest.steps.map(s => {
    let rowCls = s.decision !== 'pending' ? s.decision : (latest.status !== 'rejected' && s.stage === latest.currentStage ? 'active' : 'pending');
    const canAct = latest.status !== 'rejected' && latest.status !== 'published' && s.decision === 'pending' &&
      s.stage === latest.currentStage && (s.role === currentUser.role || currentUser.role === 'admin');
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
            status: 'pending_review', currentStage: 0, steps: freshSteps(),
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
            notifyRoles(WORKFLOW_STEPS.filter(s => s.stage === 0).map(s => s.role), `${docData.drawingNumber} — ${docData.title} resubmitted (v${newVersionNo}) and needs review.`, activeDocId);
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
    inUseMessage: 'This project is in use and cannot be deleted.',
    isInUse: item => allDocsSnapshot.some(d => d.project === item.name) },
  { key: 'departmentMasters', label: 'Departments', singular: 'department', selects: ['fDepartment','newUserDept','filterDepartment','createRoleDeptSelect','editUserDept'],
    hasSubItems: true, panelId: 'departmentsMasterPanel',
    starter: ['Engineering','Architecture','Planning','QA/QC','Project Management','Management'],
    inUseMessage: 'This department is in use and cannot be deleted.',
    isInUse: item => allDocsSnapshot.some(d => d.department === item.name) || usersData.some(u => u.department === item.name) },
  { key: 'categoryMasters',   label: 'Categories',  singular: 'category',   selects: ['fCategory','filterCategory'],
    hasSubItems: true, panelId: 'categoriesMasterPanel',
    starter: ['Structural Drawings','Architectural Drawings','MEP Drawings','Electrical Drawings','HVAC','Landscape','Legal Documents','BOQ','Quality Documents'],
    inUseMessage: 'This category is already in use and cannot be deleted.',
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
}

function isRoleInUse(roleId){
  return usersData.some(u => u.role === roleId) || WORKFLOW_STEPS.some(s => s.role === roleId);
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
   WORKFLOW CONFIGURATION (admin edits; live for everyone)
   Steps sharing a stage number run in parallel (all must approve to
   advance); different stage numbers run sequentially in ascending order.
   Admin-typed stage numbers don't need to be contiguous — they're
   normalized to 0,1,2... here, so gaps or arbitrary numbering are fine.
   This only affects documents uploaded AFTER a change; documents already
   in progress keep the step shape they were created with (see
   applyStepDecision / renderDetail, which read from each document's own
   frozen steps rather than this live config).
============================================================ */
function listenWorkflowConfig(){
  const unsub = db.collection('workflowSteps').orderBy('stage').onSnapshot(snap => {
    const raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const distinctStages = [...new Set(raw.map(s => s.stage))].sort((a,b) => a-b);
    const stageMap = new Map(distinctStages.map((s,i) => [s,i]));
    WORKFLOW_STEPS = raw.map(s => ({
      key: s.id, label: s.label || ROLE_LABELS[s.role] || s.role, role: s.role,
      stage: stageMap.get(s.stage), fromStatus: s.fromStatus || '', toStatus: s.toStatus || ''
    }));
    TOTAL_STAGES = distinctStages.length;
    if(currentUser && currentUser.role === 'admin') renderWorkflowConfigView();
  }, err => console.error('workflow config listener:', err));
  activeSessionUnsubs.push(unsub);
}

function renderWorkflowConfigView(){
  const panel = document.getElementById('workflowConfigPanel');
  if(!panel) return;
  if(WORKFLOW_STEPS.length === 0){
    panel.innerHTML = `<div class="empty-state"><div class="ic">&#8942;</div><b>No workflow configured yet</b>
      <div style="margin:8px 0 16px;">Uploads are blocked until at least one step exists.</div>
      <button class="btn btn-teal btn-sm" onclick="seedDefaultWorkflow()">Load starter workflow (4 steps, 3 stages)</button>
    </div>`;
    return;
  }
  const sorted = [...WORKFLOW_STEPS].sort((a,b) => a.stage - b.stage);
  const rows = sorted.map(s => `
    <tr>
      <td><span class="drawing-code">Stage ${s.stage + 1}</span></td>
      <td>${escapeHtml(ROLE_LABELS[s.role] || s.role)}</td>
      <td>${escapeHtml(STATUS_LABELS[s.fromStatus] || s.fromStatus || '—')}</td>
      <td>${escapeHtml(STATUS_LABELS[s.toStatus] || s.toStatus || '—')}</td>
      <td style="text-align:right;"><button class="icon-btn-sm" onclick="removeWorkflowStep('${s.key}')" title="Delete">&#128465;&#65039;</button></td>
    </tr>`).join('');

  const stageNumbers = [...new Set(WORKFLOW_STEPS.map(s => s.stage))].sort((a,b) => a - b);
  const maxStage = stageNumbers.length ? Math.max(...stageNumbers) : -1;
  const statusOptionsHtml = Object.keys(STATUS_LABELS).map(k => `<option value="${k}">${escapeHtml(STATUS_LABELS[k])}</option>`).join('');

  panel.innerHTML = `
    <table>
      <thead><tr><th>Stage</th><th>Role</th><th>From Status</th><th>To Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="workflow-add-block" style="margin-top:20px; padding-top:18px; border-top:1px solid var(--border);">
      <h4>Add Workflow Mapping</h4>
      <div class="workflow-add-row">
        <select id="newStepStage">
          ${stageNumbers.map(n => `<option value="${n}">Stage ${n + 1} (parallel with existing)</option>`).join('')}
          <option value="${maxStage + 1}" selected>New Stage ${maxStage + 2}</option>
        </select>
        <select id="newStepRole">
          <option value="">Role&hellip;</option>
          ${Object.entries(ROLE_LABELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}
        </select>
        <select id="newStepFromStatus">
          <option value="">From Status&hellip;</option>
          ${statusOptionsHtml}
        </select>
        <select id="newStepToStatus">
          <option value="">To Status&hellip;</option>
          ${statusOptionsHtml}
        </select>
        <button class="btn btn-teal btn-sm" onclick="addWorkflowStep()">+ Add Mapping</button>
      </div>
      <div class="auth-hint" style="margin-top:10px;">From/To Status document what each step represents for reference and reporting. The actual approval order and publishing still follow Stage order, exactly as before — this doesn't change how documents move through the chain.</div>
    </div>
  `;
}

function addWorkflowStep(){
  const stage = parseInt(document.getElementById('newStepStage').value, 10);
  const role = document.getElementById('newStepRole').value;
  const fromStatus = document.getElementById('newStepFromStatus').value;
  const toStatus = document.getElementById('newStepToStatus').value;
  if(!role){ toast('Please choose a role.', 'err'); return; }
  if(!fromStatus || !toStatus){ toast('Please choose both From Status and To Status.', 'err'); return; }
  const dup = WORKFLOW_STEPS.some(s => s.stage === stage && s.role === role);
  if(dup){ toast('A mapping for this role already exists at this stage.', 'err'); return; }
  const label = ROLE_LABELS[role] || role;
  db.collection('workflowSteps').add({ label, role, stage, fromStatus, toStatus, createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => toast('Mapping added.', 'ok'))
    .catch(err => toast('Could not add: ' + err.message, 'err'));
}
function removeWorkflowStep(id){
  if(WORKFLOW_STEPS.length <= 1){ toast('At least one step is required — add a replacement before removing the last one.', 'err'); return; }
  const step = WORKFLOW_STEPS.find(s => s.key === id);
  const desc = step ? `${ROLE_LABELS[step.role] || step.role} — Stage ${step.stage + 1}` : 'this mapping';
  if(!confirm(`Are you sure you want to remove this workflow mapping?\n\n"${desc}"`)) return;
  db.collection('workflowSteps').doc(id).delete()
    .then(() => toast('Mapping removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}
function seedDefaultWorkflow(){
  const batch = db.batch();
  DEFAULT_WORKFLOW_STEPS.forEach(s => {
    batch.set(db.collection('workflowSteps').doc(), {
      label: s.label, role: s.role, stage: s.stage, fromStatus: s.fromStatus, toStatus: s.toStatus,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
  batch.commit()
    .then(() => toast('Starter workflow loaded.', 'ok'))
    .catch(err => toast('Could not seed: ' + err.message, 'err'));
}

/* ============================================================
   STATUS LABELS (admin edits; live for everyone)
   The underlying status keys are fixed (they're wired into the approval
   engine's logic) — this only lets an Admin rename how each one displays.
============================================================ */
function listenStatusLabels(){
  const unsub = db.collection('statusLabels').onSnapshot(snap => {
    const overrides = {};
    snap.docs.forEach(d => { overrides[d.id] = d.data().label; });
    STATUS_LABELS = { ...DEFAULT_STATUS_LABELS, ...overrides };
    populateStatusFilterOptions();
    if(currentUser && currentUser.role === 'admin') renderStatusConfigView();
    renderDocsTable();
    renderQueue();
  }, err => console.error('status labels listener:', err));
  activeSessionUnsubs.push(unsub);
}

function renderStatusConfigView(){
  const panel = document.getElementById('statusConfigPanel');
  if(!panel) return;
  panel.innerHTML = Object.keys(DEFAULT_STATUS_LABELS).map(key => `
    <div class="status-edit-row">
      <span class="status-key">${key}</span>
      <input type="text" id="statuslabel_${key}" value="${escapeHtml(STATUS_LABELS[key])}">
      <button class="btn btn-teal btn-sm" onclick="saveStatusLabel('${key}')">Save</button>
    </div>
  `).join('');
}

function saveStatusLabel(key){
  const input = document.getElementById('statuslabel_' + key);
  const label = input.value.trim();
  if(!label){ toast('Label cannot be empty.', 'err'); return; }
  db.collection('statusLabels').doc(key).set({ label })
    .then(() => toast('Saved.', 'ok'))
    .catch(err => toast('Could not save: ' + err.message, 'err'));
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
    if(currentUser && currentUser.role === 'admin'){
      renderUsersView();
      refreshMasterDataPanels(); // department "in use" status depends on this data
      renderRolesMasterView(); // role "in use" status depends on this data
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
    return `<tr>
      <td>${escapeHtml(u.name || '—')}</td>
      <td>${escapeHtml(u.email || '—')}</td>
      <td>${escapeHtml(ROLE_LABELS[u.role] || u.role || '—')}</td>
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
  if(!name || !role){ toast('Please fill in name and role.', 'err'); return; }
  const updates = { name, role, department: department || '' };
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
  openModal('createUserModalOverlay');
}

function submitCreateUser(){
  const name = document.getElementById('newUserName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;
  const department = document.getElementById('newUserDept').value;
  if(!name || !email || !password || !role){ toast('Please fill in name, email, password, and role.', 'err'); return; }
  if(password.length < 6){ toast('Password should be at least 6 characters.', 'err'); return; }

  const btn = document.getElementById('createUserConfirmBtn');
  btn.disabled = true; btn.textContent = 'Creating…';

  const secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary-' + Date.now());
  const secondaryAuth = secondaryApp.auth();

  secondaryAuth.createUserWithEmailAndPassword(email, password)
    .then(cred => db.collection('users').doc(cred.user.uid).set({
      name, email, role, department: department || '',
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

function startListeners(){
  stopSessionListeners(); // safety: clear anything left over before attaching fresh ones
  populateStatusFilterOptions(); // seed with current STATUS_LABELS immediately, live listener refines it
  listenQueue();
  listenAllDocuments();
  listenNotifications();
  listenWorkflowConfig();
  listenStatusLabels();
  listenRoleMasters();
  if(currentUser.role === 'admin') listenUsers();
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
  WORKFLOW_STEPS = DEFAULT_WORKFLOW_STEPS.slice();
  TOTAL_STAGES = new Set(DEFAULT_WORKFLOW_STEPS.map(s => s.stage)).size;
  STATUS_LABELS = { ...DEFAULT_STATUS_LABELS };
  ROLE_LABELS = { ...DEFAULT_ROLE_LABELS };
}

listenMasters(); // public read — populate registration + upload dropdowns even before sign-in
