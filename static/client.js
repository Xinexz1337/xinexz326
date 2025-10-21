/* ================== SOCKET / STATE ================== */
const socket = io();
const roomId = DEFAULT_ROOM;



const hostSoundboard = document.getElementById("hostSoundboard");
const btnSfxGun   = document.getElementById("btnSfxGun");
const btnSfxPulse = document.getElementById("btnSfxPulse");


const sfxKill  = document.getElementById("sfxKill");
const sfxHeal  = document.getElementById("sfxHeal");
const sfxCheck = document.getElementById("sfxCheck");
const sfxHit   = document.getElementById("sfxHit");
const sfxMiss  = document.getElementById("sfxMiss");

const musicTown  = document.getElementById("musicTown");
const musicMafia = document.getElementById("musicMafia");



const finalOverlay = document.getElementById("finalOverlay");
const finalTitle   = document.getElementById("finalTitle");
const finalSub     = document.getElementById("finalSub");


const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

let localStream = null;
let mySlot = null;
let myId = null;
let videoEnabled = true;

const peers   = new Map();          // sid -> RTCPeerConnection
const peerMeta= new Map();          // sid -> {name, slot}
const modBySlot = new Map();        // slot -> null|"vote"|"expelled"|"killed"
const nominatedSlots = new Set();   // для старой подсветки выставленных

const hostFX = document.getElementById("hostFX");
const fxRed  = document.getElementById("fxRed");
const fxGreen= document.getElementById("fxGreen");


const hostFinalControls = document.getElementById("hostFinalControls");
const btnTownWin = document.getElementById("btnTownWin");
const btnMafiaWin = document.getElementById("btnMafiaWin");




// --- VOTING state ---
let votingOpen = false;
// votes: voter_slot -> target_slot
const votes = new Map();
// обратный индекс: target_slot -> [voter_slots]
const votersByTarget = new Map();

// элементы UI
const hostVoting   = document.getElementById("hostVoting");
const startVoting  = document.getElementById("startVoting");
const stopVoting   = document.getElementById("stopVoting");
const voteVoterSel = document.getElementById("voteVoter");
const voteTargetSel= document.getElementById("voteTarget");
const voteAddBtn   = document.getElementById("voteAdd");
const voteRemoveBtn= document.getElementById("voteRemove");
const votesClearBtn= document.getElementById("votesClear");







/* ================== DOM SHORTCUTS ================== */
const $ = (sel) => document.querySelector(sel);
const statusEl           = $("#status");
const joinBtn            = $("#joinBtn");
const leaveBtn           = $("#leaveBtn");
const muteVideoBtn       = $("#muteVideo");
const roleSelect         = $("#role");

// Фаза (день/ночь)
const togglePhaseBtn     = $("#togglePhase");

// Таймер
const timerDisplay       = $("#timerDisplay");
const hostTimerControls  = $("#hostTimerControls");
const start60Btn         = $("#start60");
const start30Btn         = $("#start30");

// Объявления ведущего
const hostAnnounce   = $("#hostAnnounce");
const announceTarget = $("#announceTarget");
const btnKilledDoc   = $("#btnKilledDoc");
const btnKilledCop   = $("#btnKilledCop");
const btnKilledTown  = $("#btnKilledTown");
const btnExpelMafia  = $("#btnExpelMafia");
const globalAnnounce = $("#globalAnnounce");

/* ================== UI HELPERS ================== */
function status(msg){ if (statusEl) statusEl.textContent = msg; }

function isHost(){ return mySlot === 12; }

function selfMeta(){
  const name = (typeof CURRENT_USERNAME !== "undefined" && CURRENT_USERNAME) ? CURRENT_USERNAME : "Игрок";
  return { sid: myId, slot: mySlot, name };
}

/* ================== JOIN / MEDIA ================== */
joinBtn && (joinBtn.onclick = join);
leaveBtn && (leaveBtn.onclick = leaveRoom);
muteVideoBtn && (muteVideoBtn.onclick = toggleVideo);

async function join(){
  if (joinBtn) joinBtn.disabled = true;

  const role = roleSelect ? roleSelect.value : "player"; // "player" | "host"
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
  } catch (e) {
    status("Доступ к камере/микрофону отклонён: " + e.message);
    if (joinBtn) joinBtn.disabled = false;
    return;
  }
  socket.emit("join-room", { roomId, role });
}

async function leaveRoom(){
  socket.emit("leave-room", { roomId });
  for (const [, pc] of peers) pc.close();
  peers.clear();

  for (let i=1;i<=12;i++){
    if (i!==mySlot) freeSlot(i);
  }

  status("Вы вышли из комнаты.");
  if (leaveBtn) leaveBtn.disabled = true;
  if (muteVideoBtn) muteVideoBtn.disabled = true;
  if (joinBtn) joinBtn.disabled = false;

  // скрыть панели ведущего
  if (hostTimerControls) hostTimerControls.style.display = "none";
  if (togglePhaseBtn) togglePhaseBtn.style.display = "none";
  if (hostAnnounce) hostAnnounce.style.display = "none";
}

function toggleVideo(){
  videoEnabled = !videoEnabled;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
  if (muteVideoBtn) muteVideoBtn.textContent = videoEnabled ? "📷 Выключить камеру" : "📵 Включить камеру";
}

/* ================== VIDEO ATTACH ================== */
function attachStreamToSlot(stream, slot, isLocal=false, name=""){
  const video = document.getElementById(`video-${slot}`);
  const nameEl = document.getElementById(`name-${slot}`);
  if (!video) return;

  let label;
  if (slot === 12){
    label = isLocal ? "Ведущий — Вы" : `Ведущий — ${name || "Игрок"}`;
  } else {
    label = isLocal ? "Вы" : (name || "Игрок");
  }

  video.srcObject = stream;
  if (nameEl){
    nameEl.textContent = label;
    nameEl.classList.remove("free");
  }
  if (isLocal) video.muted = true;
}

function freeSlot(slot){
  const video = document.getElementById(`video-${slot}`);
  const nameEl = document.getElementById(`name-${slot}`);
  if (video) video.srcObject = null;
  if (nameEl){
    nameEl.textContent = (slot === 12) ? "Ведущий — свободно" : "Свободно";
    nameEl.classList.add("free");
  }
}

/* ================== MODERATION STATUS (VOTE/EXPEL/KILL) ================== */
function stopFx(slot){
  const cell = document.querySelector(`.cell[data-slot="${slot}"]`);
  if (!cell) return;
  const v = cell.querySelector(".fx-video");
  if (v){ v.pause(); v.removeAttribute("src"); v.load(); v.style.display="none"; }
}

function setCellStatus(slot, status){ // null | "vote" | "expelled" | "killed"
  const cell    = document.querySelector(`.cell[data-slot="${slot}"]`);
  const badge   = document.getElementById(`badge-${slot}`);
  const curtain = cell ? cell.querySelector(".curtain") : null;
  const ctext   = cell ? cell.querySelector(".curtain-text") : null;
  const fxVideo = cell ? cell.querySelector(".fx-video") : null;
  if (!cell || !badge || !curtain || !ctext || !fxVideo) return;

  // reset
  cell.classList.remove("is-vote","is-expelled","is-killed");
  badge.textContent = ""; ctext.textContent = "";
  stopFx(slot);

  if (!status) return;

  if (status === "vote"){
    cell.classList.add("is-vote");
    badge.textContent = "ВЫСТАВЛЕН";
    ctext.textContent = "ВЫСТАВЛЕН";
    onCopCheckStart();
    return;
  }

  if (status === "expelled"){
    cell.classList.add("is-expelled");
    badge.textContent = "ВЫГНАН";
    ctext.textContent = "ВЫГНАН";
    fxVideo.src = "/static/images/выгнан.MOV";
    fxVideo.style.display = "block";
    fxVideo.currentTime = 0;
    fxVideo.play().catch(()=>{});
    return;
  }

  if (status === "killed"){
    cell.classList.add("is-killed");
    badge.textContent = "УБИТ";
    ctext.textContent = "УБИТ";
    fxVideo.src = "/static/images/убит.MOV";
    fxVideo.style.display = "block";
    fxVideo.currentTime = 0;
    fxVideo.play().catch(()=>{});
    return;
  }
}

/* сервер прислал полный снимок мод-статусов */
socket.on("mod-state", ({ bySlot }) => {
  const allSlots = new Set();
  for (let i=1;i<=12;i++) allSlots.add(i);

  allSlots.forEach((slot) => {
    const oldStatus = modBySlot.has(slot) ? modBySlot.get(slot) : null;
    const newStatus = bySlot && bySlot[slot] ? bySlot[slot] : null;
    if (oldStatus !== newStatus){
      if (newStatus) modBySlot.set(slot, newStatus);
      else modBySlot.delete(slot);
      setCellStatus(slot, newStatus);
    }
  });
});

/* ================== NOMINATIONS (если используешь) ================== */
function renderVotes(){
  for (let i=1;i<=12;i++){
    const cell = document.querySelector(`.cell[data-slot="${i}"]`);
    if (!cell) continue;
    if (nominatedSlots.has(i)) cell.classList.add("nominated");
    else cell.classList.remove("nominated");
  }
}
socket.on("vote-state", ({ slots }) => {
  nominatedSlots.clear();
  (slots || []).forEach(s => nominatedSlots.add(Number(s)));
  renderVotes();
});

/* ================== HOST CONTEXT MENU ================== */
let menuEl = null;
function closeMenu(){ if (menuEl){ menuEl.remove(); menuEl = null; } }

function openHostMenu(slot, x, y){
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "host-menu";
  menuEl.style.left = x + "px";
  menuEl.style.top  = y + "px";
  menuEl.innerHTML = `
    <button data-act="vote">Выставить</button>
    <button data-act="expelled">Выгнан</button>
    <button data-act="killed">Убит</button>
    <hr style="border:none;height:1px;background:rgba(255,255,255,.1);margin:6px 0;">
    <button data-act="clear">Снять статус</button>
  `;
  menuEl.addEventListener("click", (e)=>{
    const act = e.target.getAttribute("data-act");
    if (!act) return;
    socket.emit("moderate", { roomId, slot, action: act });
    closeMenu();
  });
  document.body.appendChild(menuEl);
}

document.addEventListener("click", (e)=>{
  const cell = e.target.closest(".cell");
  if (!cell){ closeMenu(); return; }
  const slot = Number(cell.dataset.slot || 0);
  if (!slot || slot === mySlot){ closeMenu(); return; }
  if (isHost()){
    openHostMenu(slot, e.clientX, e.clientY);
  }
});
document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeMenu(); });
document.addEventListener("mousedown", (e)=>{ if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);

/* ================== PHASE (DAY/NIGHT) ================== */
let phase = "day";
function applyPhase(p){
  phase = p;
  document.body.classList.remove("phase-day","phase-night");
  document.body.classList.add(p === "night" ? "phase-night" : "phase-day");
  if (togglePhaseBtn) togglePhaseBtn.textContent = (p === "night") ? "🌞 День" : "🌗 Ночь";
}
applyPhase("day");

togglePhaseBtn && togglePhaseBtn.addEventListener("click", ()=>{
  if (!isHost()) return;
  const next = (phase === "day") ? "night" : "day";
  socket.emit("set-phase", { roomId, phase: next });
});
socket.on("phase-changed", ({ phase: p }) => applyPhase(p));

/* ================== TIMER ================== */
function formatMMSS(sec){
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return `${String(m)}:${String(s).padStart(2,'0')}`;
}
function setTimerUI(seconds, running){
  if (!timerDisplay) return;
  timerDisplay.textContent = formatMMSS(seconds);
  timerDisplay.classList.toggle("running", running && seconds>0);
  timerDisplay.classList.toggle("ended",   !running && seconds===0);
}
setTimerUI(0, false);

start60Btn && start60Btn.addEventListener("click", ()=>{
  if (!isHost()) return;
  socket.emit("start-timer", { roomId, duration: 60 });
});
start30Btn && start30Btn.addEventListener("click", ()=>{
  if (!isHost()) return;
  socket.emit("start-timer", { roomId, duration: 30 });
});
socket.on("timer-update", ({ remaining }) => setTimerUI(remaining, remaining>0));
socket.on("timer-finished", () => setTimerUI(0, false));

/* ================== HOST ANNOUNCEMENTS ================== */
function fillAnnounceTargets(){
  if (!announceTarget) return;
  const opts = [];
  for (let i=1;i<=12;i++){
    if (i === 12) continue;
    const nameEl = document.getElementById(`name-${i}`);
    const label = nameEl ? nameEl.textContent.replace(/^Ведущий —\s*/, "") : `Слот ${i}`;
    opts.push({slot: i, label: `${i}: ${label || "Игрок"}`});
  }
  announceTarget.innerHTML = opts.map(o => `<option value="${o.slot}">${o.label}</option>`).join("");
}

function emitAnnounce(type){
  if (!isHost()) return;
  const slot = Number(announceTarget?.value || 0);
  if (!slot) return;
  socket.emit("announce-event", { roomId, type, slot });
}
btnKilledDoc  && btnKilledDoc .addEventListener("click", ()=>emitAnnounce("killed-doc"));
btnKilledCop  && btnKilledCop .addEventListener("click", ()=>emitAnnounce("killed-cop"));
btnKilledTown && btnKilledTown.addEventListener("click", ()=>emitAnnounce("killed-town"));
btnExpelMafia && btnExpelMafia.addEventListener("click", ()=>emitAnnounce("expelled-mafia"));

socket.on("announce", ({ type, slot, name }) => showAnnouncement(type, slot, name));

function showAnnouncement(type, slot, name){
  if (!globalAnnounce) return;
  globalAnnounce.innerHTML = "";
  globalAnnounce.style.display = "flex";

  const map = {
    "killed-doc":     { cls:"annc-doc",    title:"УБИЛИ ДОКТОРА" },
    "killed-cop":     { cls:"annc-cop",    title:"УБИЛИ КОМИССАРА" },
    "killed-town":    { cls:"annc-town",   title:"УБИЛИ МИРНОГО" },
    "expelled-mafia": { cls:"annc-mafia",  title:"ВЫГНАНА МАФИЯ" },
    "vote-start":    { cls:"annc-vote",   title:"ВРЕМЯ ГОЛОСОВАНИЯ" },
    "vote-winner":   { cls:"annc-vote",   title:"ИТОГ ГОЛОСОВАНИЯ" }
  };
  const cfg = map[type] || { cls:"annc-town", title:"СОБЫТИЕ" };

  const card = document.createElement("div");
  card.className = `card ${cfg.cls}`;
  card.innerHTML = `
    ${cfg.title}
    <span class="sub">Игрок #${slot}${name ? " — " + name : ""}</span>
  `;
  globalAnnounce.appendChild(card);

  spawnConfetti(globalAnnounce, type);
  setTimeout(()=>{ globalAnnounce.style.display="none"; globalAnnounce.innerHTML=""; }, 4000);
}

function spawnConfetti(root, type){
  const palette = {
    "expelled-mafia": ["#ef4444","#7f1d1d","#f59e0b"],
    "killed-doc":     ["#22d3ee","#0ea5b7","#38bdf8"],
    "killed-cop":     ["#a78bfa","#6d28d9","#c084fc"],
    "killed-town":    ["#22c55e","#16a34a","#84cc16"]
  }[type] || ["#e5e7eb","#94a3b8","#64748b"];

  const n = 40;
  const rect = root.getBoundingClientRect();
  for (let i=0;i<n;i++){
    const s = document.createElement("span");
    s.className = "confetti-piece";
    s.style.left = (rect.width/2 + (Math.random()*240-120)) + "px";
    s.style.top  = (rect.height/2 - 120 + Math.random()*40) + "px";
    s.style.background = palette[i % palette.length];
    s.style.transform = `translateY(0) rotate(${Math.random()*180}deg)`;
    s.style.animationDelay = (Math.random()*.2) + "s";
    s.style.opacity = 0.8 + Math.random()*0.2;
    s.style.width = (8 + Math.random()*6) + "px";
    s.style.height = (10 + Math.random()*10) + "px";
    root.appendChild(s);
    setTimeout(()=> s.remove(), 1600);
  }
}

/* ================== SOCKET EVENTS: ROOM/WEBRTC ================== */
socket.on("auth-required", ({message}) => {
  status(message + " (зайдите через /login)");
  if (joinBtn) joinBtn.disabled = false;
});

socket.on("host-slot-busy", () => {
  status("Слот ведущего занят. Выберите роль 'Игрок' или подождите.");
  if (joinBtn) joinBtn.disabled = false;
});

socket.on("joined", async ({ selfId, slot, peers: existingPeers=[] }) => {
  myId = selfId;
  mySlot = slot;
  hostFX.style.display = (slot === 12) ? "inline-flex" : "none";
  hostSoundboard.style.display = (slot === 12) ? "inline-flex" : "none";
  hostFinalControls.style.display = (slot === 12) ? "inline-flex" : "none";

  attachStreamToSlot(localStream, mySlot, true, "Вы");
  if (leaveBtn) leaveBtn.disabled = false;
  if (muteVideoBtn) muteVideoBtn.disabled = false;
  status(`Вы в комнате (${roomId}). Ваш слот #${mySlot}. Участников: ${existingPeers.length + 1}`);

  // показать панели ведущего
  if (togglePhaseBtn) togglePhaseBtn.style.display = isHost() ? "inline-block" : "none";
  if (hostTimerControls) hostTimerControls.style.display = isHost() ? "inline-flex" : "none";
  if (hostAnnounce) hostAnnounce.style.display = isHost() ? "inline-flex" : "none";

  hostVoting.style.display = (slot === 12) ? "inline-flex" : "none";

  // заполнить список целей
  fillAnnounceTargets();

  for (const p of existingPeers){
    peerMeta.set(p.sid, { name: p.name, slot: p.slot });
    await createPeerConnectionAndCall(p.sid, p.slot, p.name, true);
  }
});

socket.on("peer-joined", ({ sid, name, slot }) => {
  peerMeta.set(sid, { name, slot });
  const nameEl = document.getElementById(`name-${slot}`);
  if (nameEl){ nameEl.textContent = name; nameEl.classList.remove("free"); }
  status(`Подключился ${name} (слот ${slot})`);
  fillAnnounceTargets();
});

socket.on("peer-left", ({ sid, slot }) => {
  const pc = peers.get(sid);
  if (pc) pc.close();
  peers.delete(sid);
  peerMeta.delete(sid);
  freeSlot(slot);
  status(`Игрок покинул комнату (слот ${slot})`);
  fillAnnounceTargets();
});

socket.on("webrtc-offer", async ({ from, sdp }) => {
  const { sid, slot, name } = from;
  peerMeta.set(sid, { name, slot });
  const pc = await createPeerConnectionAndCall(sid, slot, name, false);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("webrtc-answer", { target: sid, from: selfMeta(), sdp: answer });
});

socket.on("webrtc-answer", async ({ from, sdp }) => {
  const { sid } = from;
  const pc = peers.get(sid);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on("webrtc-ice", async ({ from, candidate }) => {
  const { sid } = from;
  const pc = peers.get(sid);
  if (!pc || !candidate) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.warn(e); }
});

async function createPeerConnectionAndCall(remoteSid, remoteSlot, remoteName, isCaller){
  if (peers.get(remoteSid)) return peers.get(remoteSid);

  const pc = new RTCPeerConnection({ iceServers });
  peers.set(remoteSid, pc);

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    attachStreamToSlot(stream, remoteSlot, false, remoteName);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate){
      socket.emit("webrtc-ice", { target: remoteSid, from: selfMeta(), candidate: e.candidate });
    }
  };

  if (isCaller){
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    socket.emit("webrtc-offer", { target: remoteSid, from: selfMeta(), sdp: offer });
  }
  return pc;
}

function fillVotingSelects() {
  const opts = [];
  for (let i=1;i<=12;i++){
    // чаще всего ведущего (12) не голосуют; при желании оставь:
    // if (i===12) continue;
    const nameEl = document.getElementById(`name-${i}`);
    const label = nameEl ? nameEl.textContent || `Слот ${i}` : `Слот ${i}`;
    opts.push(`<option value="${i}">${i}: ${label}</option>`);
  }
  voteVoterSel.innerHTML  = opts.join("");
  voteTargetSel.innerHTML = opts.join("");
}

function renderVotesUI(){
  // сначала очистим старые элементы
  for (let i=1;i<=12;i++){
    const cell = document.querySelector(`.cell[data-slot="${i}"]`);
    if (!cell) continue;
    // remove old nodes
    cell.querySelectorAll(".votes-count, .vote-bubbles").forEach(n=>n.remove());
  }

  if (!votingOpen) return;

  // построим обратный индекс
  votersByTarget.clear();
  votes.forEach((tgt, voter)=>{
    if (!votersByTarget.has(tgt)) votersByTarget.set(tgt, []);
    votersByTarget.get(tgt).push(voter);
  });

  // отрисовка по слотам
  for (let i=1;i<=12;i++){
    const cell = document.querySelector(`.cell[data-slot="${i}"]`);
    if (!cell) continue;

    const list = votersByTarget.get(i) || [];
    if (!list.length) continue;

    // счётчик
    const badge = document.createElement("div");
    badge.className = "votes-count";
    badge.textContent = `ГОЛОСОВ: ${list.length}`;
    badge.style.display = "inline-block";
    cell.appendChild(badge);

    // столбик пузырьков
    const stack = document.createElement("div");
    stack.className = "vote-bubbles";
    list
      .sort((a,b)=>a-b)
      .forEach((v, idx)=>{
        const b = document.createElement("div");
        b.className = `vote-bubble vote-color-${idx%8}`;
        b.textContent = v;
        stack.appendChild(b);
      });
    cell.appendChild(stack);
  }
}




startVoting?.addEventListener("click", ()=>{
  if (mySlot !== 12) return;
  fillVotingSelects();
  socket.emit("voting-start", { roomId });
});

stopVoting?.addEventListener("click", ()=>{
  if (mySlot !== 12) return;
  socket.emit("voting-stop", { roomId });
});

voteAddBtn?.addEventListener("click", ()=>{
  if (mySlot !== 12 || !votingOpen) return;
  const voter  = Number(voteVoterSel.value);
  const target = Number(voteTargetSel.value);
  if (!voter || !target || voter===target) return;
  socket.emit("voting-add", { roomId, voter, target });
});

voteRemoveBtn?.addEventListener("click", ()=>{
  if (mySlot !== 12 || !votingOpen) return;
  const voter = Number(voteVoterSel.value);
  if (!voter) return;
  socket.emit("voting-remove", { roomId, voter });
});

votesClearBtn?.addEventListener("click", ()=>{
  if (mySlot !== 12 || !votingOpen) return;
  socket.emit("voting-clear", { roomId });
});




// сервер говорит: голосование включено
socket.on("voting-opened", ()=>{
  votingOpen = true;
  votes.clear();
  // баннер
  showAnnouncement("vote-start", 0, "");
  // переключаем кнопки
  startVoting.style.display = "none";
  stopVoting.style.display  = "inline-block";
  renderVotesUI();
});

// сервер говорит: голосование выключено
socket.on("voting-closed", ()=>{
  votingOpen = false;
  votes.clear();
  startVoting.style.display = "inline-block";
  stopVoting.style.display  = "none";
  // можно показать финальную сводку, если пришла (ниже)
  renderVotesUI();
});

// сервер шлёт актуальное состояние голосов
socket.on("votes-state", ({ pairs })=>{
  // pairs: [{voter: 3, target: 7}, ...]
  votes.clear();
  (pairs||[]).forEach(p=> votes.set(Number(p.voter), Number(p.target)));
  renderVotesUI();
});

// финальная сводка (опционально)
socket.on("votes-summary", ({ counts })=>{
  // counts: { "1":3, "7":5, ... } — можно всплывашку показать
  // тут — просто баннер с победившим
  const entries = Object.entries(counts||{}).map(([slot,c])=>({slot:Number(slot),count:c}));
  if (!entries.length) return;
  entries.sort((a,b)=>b.count-a.count);
  const top = entries[0];
  showAnnouncement("vote-winner", top.slot, `ГОЛОСОВ: ${top.count}`);
});





// ведущий нажимает
fxRed?.addEventListener("click", ()=>{ if (mySlot===12) socket.emit("fx-signal", {roomId, color:"red"}); });
fxGreen?.addEventListener("click", ()=>{ if (mySlot===12) socket.emit("fx-signal", {roomId, color:"green"}); });

// все получают эффект
socket.on("fx-trigger", ({ color })=>{
  triggerFX(color);
});

function triggerFX(color){
  const overlay = document.createElement("div");
  overlay.className = `fx-overlay fx-${color}`;
  document.body.appendChild(overlay);
  setTimeout(()=>overlay.remove(), 1500);
}




function playAudio(el, {volume=1, restart=true}={}){
  if (!el) return;
  try {
    if (restart) { el.currentTime = 0; }
    el.volume = volume;
    el.play().catch(()=>{ /* ignore */ });
  } catch(e){}
}
function stopAudio(el){
  try{ el.pause(); }catch(e){}
}

// пример: когда ты меняешь статус слота на "killed"
function onSomeoneKilled(){
  playAudio(sfxKill, {volume:0.4});
}
// пример: когда лечат
function onSomeoneHealed(){
  playAudio(sfxHeal, {volume:0.9});
}
// пример: комиссар проверил (короткий щелчок)
function onCopCheckStart(){
  playAudio(sfxCheck, {volume:0.7});
}
// результат проверки комиссара
function onCopCheckResult(isMafia){
  playAudio(isMafia ? sfxHit : sfxMiss, {volume:0.9});
}



function spawnFinalConfetti(palette=["#fff"]){
  for (let i=0;i<60;i++){
    const s = document.createElement("span");
    s.className = "final-confetti";
    s.style.background = palette[i % palette.length];
    s.style.left = Math.random()*100 + "vw";
    s.style.setProperty("--dx", (Math.random()*300-150) + "px");
    s.style.width  = (6 + Math.random()*6) + "px";
    s.style.height = (8 + Math.random()*10) + "px";
    document.body.appendChild(s);
    setTimeout(()=>s.remove(), 1700);
  }
}

function stopFinalMusic(){
  stopAudio(musicTown); stopAudio(musicMafia);
}

function showFinalScene({winner="town", reason=""}={}){
  // winner: "town" | "mafia"
  stopFinalMusic();

  finalOverlay.classList.remove("town","mafia");
  finalOverlay.classList.add(winner === "mafia" ? "mafia" : "town");

  if (winner === "mafia"){
    finalTitle.textContent = "МАФИЯ ПОБЕДИЛА";
    finalSub.textContent   = reason ? reason : "Город пал…";
    playAudio(musicMafia, {volume:0.8, restart:true});
    spawnFinalConfetti(["#ef4444","#7f1d1d","#f59e0b"]);
  } else {
    finalTitle.textContent = "МИРНЫЕ ПОБЕДИЛИ";
    finalSub.textContent   = reason ? reason : "Правосудие восторжествовало!";
    playAudio(musicTown, {volume:0.8, restart:true});
    spawnFinalConfetti(["#22c55e","#16a34a","#84cc16","#fde047"]);
  }

  finalOverlay.style.display = "flex";
  // Скрытие по клику (если надо) — раскомментируй:
  // finalOverlay.addEventListener("click", hideFinalScene, {once:true});
}

function hideFinalScene(){
  finalOverlay.style.display = "none";
  stopFinalMusic();
}

// Хост жмёт финал
btnTownWin?.addEventListener("click", ()=>{
  if (mySlot !== 12) return;
  socket.emit("game-over", {roomId, winner:"town", reason:"Все мафы повешены"});
});
btnMafiaWin?.addEventListener("click", ()=>{
  if (mySlot !== 12) return;
  socket.emit("game-over", {roomId, winner:"mafia", reason:"Мафия взяла контроль"});
});

// Все получают финал
socket.on("game-over-broadcast", ({winner, reason})=>{
  showFinalScene({winner, reason});
});

btnSfxGun?.addEventListener("click",   () => { if (mySlot===12) socket.emit("sfx-play", {roomId, type:"gunshot"}); });
btnSfxPulse?.addEventListener("click", () => { if (mySlot===12) socket.emit("sfx-play", {roomId, type:"pulse"});   });


socket.on("sfx-play", ({type}) => {
  if (type === "gunshot") {          // используй kill как «выстрел»
    playAudio(sfxKill, {volume:0.5});
  } else if (type === "pulse") {
    playAudio(sfxHeal, {volume:0.5});
  }
});