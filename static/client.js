
const socket = io();
const roomId = DEFAULT_ROOM;
const nominatedSlots = new Set();


const togglePhaseBtn = document.getElementById("togglePhase");
let phase = "day"; // локальное состояние (для подписи на кнопке)

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" }
];

let localStream = null;
let mySlot = null;
let myId = null;
let audioEnabled = true;
let videoEnabled = true;

const peers = new Map();
const peerMeta = new Map();
const modBySlot = new Map();

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

$("#joinBtn").onclick = join;
$("#leaveBtn").onclick = leaveRoom;
$("#muteVideo").onclick = toggleVideo;

async function join(){
  $("#joinBtn").disabled = true;
  const role = document.getElementById("role").value; // "player" | "host"

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
  } catch (e) {
    status("Доступ к камере/микрофону отклонён: " + e.message);
    $("#joinBtn").disabled = false;
    return;
  }
  socket.emit("join-room", { roomId, role });   // ← отправляем роль
}

// если ведущий уже есть
socket.on("host-slot-busy", () => {
  status("Слот ведущего занят. Выберите роль 'Игрок' или подождите.");
  $("#joinBtn").disabled = false;
});


function setCellStatus(slot, status){ // null | "vote" | "expelled" | "killed"
  const cell    = document.querySelector(`.cell[data-slot="${slot}"]`);
  const badge   = document.getElementById(`badge-${slot}`);
  const curtain = cell ? cell.querySelector(".curtain") : null;
  const ctext   = cell ? cell.querySelector(".curtain-text") : null;
  const fxVideo = cell ? cell.querySelector(".fx-video") : null;
  if (!cell || !badge || !curtain || !ctext || !fxVideo) return;

  // сброс
  cell.classList.remove("is-vote","is-expelled","is-killed");
  badge.textContent = ""; ctext.textContent = "";
  stopFx(slot);

  if (!status) return;

  if (status === "expelled") {
    cell.classList.add("is-expelled");
    badge.textContent = "ВЫГНАН";
    ctext.textContent = "ВЫГНАН";

    // твой файл — путь относительный к /static/
    fxVideo.src = "/static/images/выгнан.MOV";
    fxVideo.style.display = "block";
    fxVideo.currentTime = 0;
    fxVideo.play().catch(()=>{ /* в некоторых браузерах нужно взаимодействие пользователя */ });
    return;
  }

  if (status === "vote") {
    cell.classList.add("is-vote");
    badge.textContent = "ВЫСТАВЛЕН";
    ctext.textContent = "ВЫСТАВЛЕН";
    return;
  }

  if (status === "killed") {
    cell.classList.add("is-killed");
    badge.textContent = "УБИТ";
    ctext.textContent = "УБИТ";
    fxVideo.src = "/static/images/убит.MOV";
    fxVideo.style.display = "block";
    fxVideo.currentTime = 0;
    fxVideo.play().catch(()=>{ /* в некоторых браузерах нужно взаимодействие пользователя */ });
    return;
  }
}


socket.on("mod-state", ({ bySlot }) => {
  // Собираем множество всех слотов (и старых, и новых), чтобы увидеть и добавления, и удаления
  const allSlots = new Set();
  for (let i = 1; i <= 12; i++) allSlots.add(i);

  // По каждому слоту сравниваем old/new — меняем только если отличается
  allSlots.forEach((slot) => {
    const oldStatus = modBySlot.has(slot) ? modBySlot.get(slot) : null;
    const newStatus = bySlot && bySlot[slot] ? bySlot[slot] : null;

    if (oldStatus !== newStatus) {
      // Обновляем локальное состояние
      if (newStatus) modBySlot.set(slot, newStatus);
      else modBySlot.delete(slot);

      // И только теперь перерисовываем конкретный слот
      setCellStatus(slot, newStatus);
    }
  });
});


function renderMod(){
  for (let i=1;i<=12;i++){
    setCellStatus(i, modBySlot.get(i) || null);
  }
}


function renderVotes() {
  for (let i=1; i<=12; i++){
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



function isHost(){ return mySlot === 12; }

let menuEl = null;
function closeMenu(){ if (menuEl){ menuEl.remove(); menuEl=null; } }

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

// Открываем меню по клику ведущего на чужой слот
document.addEventListener("click", (e)=>{
  const cell = e.target.closest(".cell");
  if (!cell) { closeMenu(); return; }
  const slot = Number(cell.dataset.slot || 0);
  if (!slot || slot === mySlot) { closeMenu(); return; }
  if (isHost()){
    const rect = cell.getBoundingClientRect();
    openHostMenu(slot, e.clientX, e.clientY);
  }
});

// Закрытие при клике вне/ESC
document.addEventListener("keydown", (e)=>{ if (e.key === "Escape") closeMenu(); });
document.addEventListener("mousedown", (e)=>{ if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);



function attachStreamToSlot(stream, slot, isLocal = false, name = "") {
  const video = document.getElementById(`video-${slot}`);
  const nameEl = document.getElementById(`name-${slot}`);
  if (!video) return;

  // Формируем подпись
  let label;
  if (slot === 12) {
    // 12-й слот — ведущий
    if (isLocal) label = "Ведущий — Вы";
    else        label = `Ведущий — ${name || "Игрок"}`;
  } else {
    label = isLocal ? "Вы" : (name || "Игрок");
  }

  video.srcObject = stream;
  if (nameEl) {
    nameEl.textContent = label;
    nameEl.classList.remove("free");
  }

  if (isLocal) video.muted = true;
}

function freeSlot(slot){
  const video = document.getElementById(`video-${slot}`);
  const nameEl = document.getElementById(`name-${slot}`);
  if (video) video.srcObject = null;

  if (nameEl) {
    nameEl.textContent = (slot === 12) ? "Ведущий — свободно" : "Свободно";
    nameEl.classList.add("free");
  }
}

socket.on("auth-required", ({message}) => {
  status(message + " (зайдите через /login)");
  $("#joinBtn").disabled = false;
});



function applyPhase(p){
  phase = p;
  document.body.classList.remove("phase-day","phase-night");
  document.body.classList.add(p === "night" ? "phase-night" : "phase-day");
  if (togglePhaseBtn) togglePhaseBtn.textContent = (p === "night") ? "🌞 День" : "🌗 Ночь";
}

// при загрузке — день
applyPhase("day");



socket.on("joined", async ({ selfId, slot, peers: existingPeers=[] }) => {
  myId = selfId; mySlot = slot;
  attachStreamToSlot(localStream, mySlot, true, "Вы");
  $("#leaveBtn").disabled = false;
  $("#muteVideo").disabled = false;

  // ведущий видит кнопку
  if (slot === 12) {
    togglePhaseBtn.style.display = "inline-block";
  } else {
    togglePhaseBtn.style.display = "none";
  }

  for (const p of existingPeers){
    peerMeta.set(p.sid, { name: p.name, slot: p.slot });
    await createPeerConnectionAndCall(p.sid, p.slot, p.name, true);
  }
});

socket.on("peer-joined", ({ sid, name, slot }) => {
  peerMeta.set(sid, { name, slot });
  const nameEl = document.getElementById(`name-${slot}`);
  if (nameEl) { nameEl.textContent = name; nameEl.classList.remove("free"); }
  status(`Подключился ${name} (слот ${slot})`);
});

socket.on("peer-left", ({ sid, slot }) => {
  const pc = peers.get(sid);
  if (pc){ pc.close(); }
  peers.delete(sid);
  peerMeta.delete(sid);
  freeSlot(slot);
  status(`Игрок покинул комнату (слот ${slot})`);
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

function selfMeta(){
  const name = (typeof CURRENT_USERNAME !== "undefined" && CURRENT_USERNAME) ? CURRENT_USERNAME : "Игрок";
  return { sid: myId, slot: mySlot, name };
}

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

function status(msg){ statusEl.textContent = msg; }

async function leaveRoom(){
  socket.emit("leave-room", { roomId });
  for (const [sid, pc] of peers){ pc.close(); }
  peers.clear();
  for (let i=1;i<=12;i++){ if (i!==mySlot) freeSlot(i); }
  status("Вы вышли из комнаты.");
  $("#leaveBtn").disabled = true;
  $("#muteVideo").disabled = true;
  $("#joinBtn").disabled = false;
}

function toggleVideo(){
  videoEnabled = !videoEnabled;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
  $("#muteVideo").textContent = videoEnabled ? "📷 Камера" : "📵 Включить камеру";
}


function stopFx(slot){
  const cell = document.querySelector(`.cell[data-slot="${slot}"]`);
  if (!cell) return;
  const v = cell.querySelector(".fx-video");
  if (v){ v.pause(); v.removeAttribute("src"); v.load(); v.style.display="none"; }
}

// ведущий нажимает — шлём команду
togglePhaseBtn?.addEventListener("click", () => {
  if (mySlot !== 12) return; // только ведущий
  const next = (phase === "day") ? "night" : "day";
  socket.emit("set-phase", { roomId, phase: next });
  // сервер всем подтвердит (включая отправителя) событием ниже
});

// всем прилетает новая фаза
socket.on("phase-changed", ({ phase: p }) => {
  applyPhase(p);
});


const timerDisplay = document.getElementById("timerDisplay");
const hostTimerControls = document.getElementById("hostTimerControls");
const start60Btn = document.getElementById("start60");
const start30Btn = document.getElementById("start30");

function formatMMSS(sec){
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return `${String(m).padStart(1,'0')}:${String(s).padStart(2,'0')}`;
}
function setTimerUI(seconds, running){
  timerDisplay.textContent = formatMMSS(seconds);
  timerDisplay.classList.toggle("running", running && seconds>0);
  timerDisplay.classList.toggle("ended", !running && seconds===0);
}

// по умолчанию пусто
setTimerUI(0, false);

// показать кнопки только ведущему
socket.on("joined", async ({ selfId, slot, peers: existingPeers=[] }) => {
  myId = selfId; mySlot = slot;
  attachStreamToSlot(localStream, mySlot, true, "Вы");
  $("#leaveBtn").disabled = false;
  $("#muteVideo").disabled = false;

  // видимость кнопок
  hostTimerControls.style.display = (slot === 12) ? "inline-flex" : "none";
  togglePhaseBtn.style.display = (slot === 12) ? "inline-block" : "none";

  for (const p of existingPeers){
    peerMeta.set(p.sid, { name: p.name, slot: p.slot });
    await createPeerConnectionAndCall(p.sid, p.slot, p.name, true);
  }
});

// нажатия ведущего
start60Btn?.addEventListener("click", () => {
  if (mySlot !== 12) return;
  socket.emit("start-timer", { roomId, duration: 60 });
});
start30Btn?.addEventListener("click", () => {
  if (mySlot !== 12) return;
  socket.emit("start-timer", { roomId, duration: 30 });
});

// серверные события таймера
socket.on("timer-update", ({ remaining }) => {
  setTimerUI(remaining, remaining > 0);
});
socket.on("timer-finished", () => {
  setTimerUI(0, false);
});