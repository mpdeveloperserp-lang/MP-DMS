/* ============================================================
   HELPERS
============================================================ */
function escapeHtml(str){
  if(str===undefined || str===null) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  db.collection('notifications').where('forRole','==',currentUser.role).orderBy('createdAt','desc').limit(30)
    .onSnapshot(snap => { snap.docChanges().forEach(upsertNotif); renderNotifications(); },
      err => console.error('notif(role) listener:', err));
  db.collection('notifications').where('toUid','==',currentUser.uid).orderBy('createdAt','desc').limit(30)
    .onSnapshot(snap => { snap.docChanges().forEach(upsertNotif); renderNotifications(); },
      err => console.error('notif(uid) listener:', err));
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
function listenQueue(){
  db.collectionGroup('versions').where('status','in',['pending_review','pending_approval'])
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
}
function renderQueue(){
  const mine = Array.from(queueMap.values()).filter(v =>
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
    <div class="stat-card accent-red"><div class="num">${overdueCount}</div><div class="lbl">Overdue &gt; 2 days</div></div>
    <div class="stat-card accent-teal"><div class="num">${queueMap.size}</div><div class="lbl">Active in the workflow</div></div>
    <div class="stat-card"><div class="num">${publishedCount}</div><div class="lbl">Published documents</div></div>`;

  const list = document.getElementById('queueList');
  if(mine.length === 0){
    list.innerHTML = `<div class="empty-state"><div class="ic">&#9989;</div><b>Queue clear</b><div>Nothing is waiting on your ${escapeHtml(ROLE_LABELS[currentUser.role]||'')} approval right now.</div></div>`;
    return;
  }
  list.innerHTML = mine.map(v => {
    const myStep = v.steps.find(s => s.stage === v.currentStage && s.decision === 'pending' && (s.role === currentUser.role || currentUser.role === 'admin'));
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
        <button class="btn btn-teal btn-sm" onclick="openDecisionModal('${v.docId}','${v.id}','${myStep.key}','approved')">Approve</button>
        <button class="btn btn-red btn-sm" onclick="openDecisionModal('${v.docId}','${v.id}','${myStep.key}','rejected')">Reject</button>
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
  db.collection('documents').orderBy('updatedAt','desc').limit(100).onSnapshot(snap => {
    allDocsSnapshot = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDocsTable();
    renderQueue();
  }, err => {
    console.error('documents listener:', err);
    document.getElementById('docsTableBody').innerHTML = `<tr><td colspan="6"><div class="empty-state"><b>Could not load documents</b></div></td></tr>`;
  });
}
function renderDocsTable(){
  const body = document.getElementById('docsTableBody');
  if(allDocsSnapshot.length === 0){
    body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="ic">&#128193;</div><b>No documents yet</b><div>Upload the first one from the Upload Document tab.</div></div></td></tr>`;
    return;
  }
  body.innerHTML = allDocsSnapshot.map(d => `
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

  const stageNodes = WORKFLOW_STEPS.map(s => {
    const st = latest.steps.find(x => x.key === s.key);
    let cls = 'pending';
    if(st.decision === 'approved') cls = 'done';
    else if(st.decision === 'rejected') cls = 'rejected';
    else if(latest.status !== 'rejected' && s.stage === latest.currentStage) cls = 'active';
    const icon = cls === 'done' ? '&#10003;' : (cls === 'rejected' ? '&#10007;' : (s.stage+1));
    return `<div class="stage-node ${cls}"><div class="line"></div><div class="circle">${icon}</div><div class="lbl">${escapeHtml(s.label)}</div></div>`;
  }).join('');

  const stepRows = latest.steps.map(s => {
    let rowCls = s.decision !== 'pending' ? s.decision : (latest.status !== 'rejected' && s.stage === latest.currentStage ? 'active' : 'pending');
    const canAct = latest.status !== 'rejected' && latest.status !== 'published' && s.decision === 'pending' &&
      s.stage === latest.currentStage && (s.role === currentUser.role || currentUser.role === 'admin');
    const icon = s.decision === 'approved' ? '&#10003;' : s.decision === 'rejected' ? '&#10007;' : (rowCls === 'active' ? '&#8987;' : '&hellip;');
    let extra;
    if(s.decision !== 'pending'){
      extra = `<div class="m">${s.decision === 'approved' ? 'Approved' : 'Rejected'} by <b>${escapeHtml(s.decidedByName||'')}</b> &middot; ${timeAgo(s.decidedAt)}</div>`;
      if(s.remarks) extra += `<div class="remarks">${escapeHtml(s.remarks)}</div>`;
    } else {
      extra = `<div class="m">Assigned to ${escapeHtml(ROLE_LABELS[s.role]||s.role)}${currentUser.role==='admin'?' <span style="color:var(--gold);">(admin override available)</span>':''}</div>`;
    }
    const actions = canAct ? `<div class="step-row-actions">
        <button class="btn btn-teal btn-sm" onclick="openDecisionModal('${activeDocId}','${latest.id}','${s.key}','approved')">Approve</button>
        <button class="btn btn-red btn-sm" onclick="openDecisionModal('${activeDocId}','${latest.id}','${s.key}','rejected')">Reject</button>
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
function openDecisionModal(docId, versionId, stepKey, decision){
  pendingDecision = { docId, versionId, stepKey, decision };
  const step = WORKFLOW_STEPS.find(s => s.key === stepKey);
  const isFinal = step.stage === TOTAL_STAGES - 1;

  document.getElementById('decisionTitle').textContent = (decision === 'approved' ? 'Approve — ' : 'Reject — ') + step.label;
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
  btn.onclick = confirmDecision;
  openModal('decisionModalOverlay');
}

function confirmDecision(){
  const remarks = document.getElementById('decisionRemarks').value.trim();
  const { docId, versionId, stepKey, decision } = pendingDecision;
  const step = WORKFLOW_STEPS.find(s => s.key === stepKey);
  const isFinal = step.stage === TOTAL_STAGES - 1;

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
        if(newStage >= TOTAL_STAGES){ newStatus = 'published'; published = true; }
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
    return { newStatus, newStage, published, docTitle: v.docTitle, docDrawingNumber: v.docDrawingNumber, uploadedBy: v.uploadedBy, decision };
  })).then(result => {
    if(result.decision === 'rejected'){
      notifyUser(result.uploadedBy, `${result.docDrawingNumber} — ${result.docTitle} was rejected. See remarks and resubmit.`, docId);
      toast('Document rejected. The uploader has been notified.', 'ok');
    } else if(result.published){
      notifyUser(result.uploadedBy, `${result.docDrawingNumber} — ${result.docTitle} has been approved and published.`, docId);
      toast('Approved, signed, and published.', 'ok');
    } else if(result.newStatus === 'pending_approval'){
      const nextRoles = WORKFLOW_STEPS.filter(s => s.stage === result.newStage).map(s => s.role);
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
            notifyRoles(['planning_engineer','qa_manager'], `${docData.drawingNumber} — ${docData.title} resubmitted (v${newVersionNo}) and needs Stage 1 review.`, activeDocId);
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
============================================================ */
const MASTER_TYPES = [
  { key: 'projectMasters',    label: 'Projects',    singular: 'project',    selects: ['fProject'],
    starter: ['MP Winter','MP Merlin','MP Golden Heights','MP Pace Petals','MP Eden'] },
  { key: 'departmentMasters', label: 'Departments', singular: 'department', selects: ['fDepartment','regDept'],
    starter: ['Engineering','Architecture','Planning','QA/QC','Project Management','Management'] },
  { key: 'categoryMasters',   label: 'Categories',  singular: 'category',   selects: ['fCategory'],
    starter: ['Structural Drawings','Architectural Drawings','MEP Drawings','Electrical Drawings','HVAC','Landscape','Legal Documents','BOQ','Quality Documents'] }
];
let mastersData = { projectMasters: [], departmentMasters: [], categoryMasters: [] };

function listenMasters(){
  MASTER_TYPES.forEach(mt => {
    db.collection(mt.key).orderBy('name').onSnapshot(snap => {
      mastersData[mt.key] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      mt.selects.forEach(selId => populateSelect(selId, mastersData[mt.key]));
      if(currentUser && currentUser.role === 'admin') renderMastersView();
    }, err => console.error(mt.key + ' listener:', err));
  });
}

function populateSelect(selectId, items){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  const prevValue = sel.value;
  const placeholder = sel.options[0] && sel.options[0].value === '' ? sel.options[0].outerHTML : '';
  sel.innerHTML = placeholder + items.map(it => `<option>${escapeHtml(it.name)}</option>`).join('');
  if(items.some(it => it.name === prevValue)) sel.value = prevValue;
}

function renderMastersView(){
  const grid = document.getElementById('mastersGrid');
  if(!grid) return;
  grid.innerHTML = MASTER_TYPES.map(mt => {
    const items = mastersData[mt.key];
    const listHtml = items.length
      ? items.map(it => `<div class="master-item"><span>${escapeHtml(it.name)}</span><button onclick="removeMasterEntry('${mt.key}','${it.id}')" title="Remove">&times;</button></div>`).join('')
      : `<div class="master-empty">No entries yet.<br><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="seedMasterDefaults('${mt.key}')">Load starter list (${mt.starter.length})</button></div>`;
    return `<div class="master-card">
      <h4>${mt.label}</h4>
      <div class="master-add-row">
        <input type="text" id="new_${mt.key}" placeholder="Add ${mt.singular}&hellip;" onkeydown="if(event.key==='Enter'){event.preventDefault(); addMasterEntry('${mt.key}');}">
        <button class="btn btn-teal btn-sm" onclick="addMasterEntry('${mt.key}')">Add</button>
      </div>
      <div class="master-list">${listHtml}</div>
    </div>`;
  }).join('');
}

function addMasterEntry(typeKey){
  const input = document.getElementById('new_' + typeKey);
  const name = input.value.trim();
  if(!name) return;
  const existing = mastersData[typeKey].some(it => it.name.toLowerCase() === name.toLowerCase());
  if(existing){ toast('That entry already exists.', 'err'); return; }
  db.collection(typeKey).add({ name, createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(() => { input.value = ''; toast('Added.', 'ok'); })
    .catch(err => toast('Could not add: ' + err.message, 'err'));
}
function removeMasterEntry(typeKey, id){
  db.collection(typeKey).doc(id).delete()
    .then(() => toast('Removed.', 'ok'))
    .catch(err => toast('Could not remove: ' + err.message, 'err'));
}
function seedMasterDefaults(typeKey){
  const mt = MASTER_TYPES.find(m => m.key === typeKey);
  const batch = db.batch();
  mt.starter.forEach(name => {
    batch.set(db.collection(typeKey).doc(), { name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
  });
  batch.commit()
    .then(() => toast(`Loaded starter ${mt.label.toLowerCase()} list.`, 'ok'))
    .catch(err => toast('Could not seed: ' + err.message, 'err'));
}

/* ============================================================
   BOOTSTRAP
============================================================ */
listenMasters(); // public read — populate registration + upload dropdowns even before sign-in
function startListeners(){
  listenQueue();
  listenAllDocuments();
  listenNotifications();
  renderMastersView(); // in case this admin loaded masters before currentUser was set
}
