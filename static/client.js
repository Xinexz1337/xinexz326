/* ================== SOCKET / STATE ================== */
const socket = io();
const roomId = DEFAULT_ROOM;

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

let localStream = null;
let mySlot = null;
let myId = null;
let videoEnabled = true;

const peers   = new Map();          // sid -> RTCPeerConnection
const peerMeta= new Map();          // sid -> {name, slot}
const modBySlot = new Map();        // slot -> null|"vote"|"expelled"|"killed"
const nominatedSlots = new Set();   // для старой подсветки выставленных

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
    "expelled-mafia": { cls:"annc-mafia",  title:"ВЫГНАНА МАФИЯ" }
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
  setTimeout(()=>{ globalAnnounce.style.display="none"; globalAnnounce.innerHTML=""; }, 3000);
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

  attachStreamToSlot(localStream, mySlot, true, "Вы");
  if (leaveBtn) leaveBtn.disabled = false;
  if (muteVideoBtn) muteVideoBtn.disabled = false;
  status(`Вы в комнате (${roomId}). Ваш слот #${mySlot}. Участников: ${existingPeers.length + 1}`);

  // показать панели ведущего
  if (togglePhaseBtn) togglePhaseBtn.style.display = isHost() ? "inline-block" : "none";
  if (hostTimerControls) hostTimerControls.style.display = isHost() ? "inline-flex" : "none";
  if (hostAnnounce) hostAnnounce.style.display = isHost() ? "inline-flex" : "none";

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
