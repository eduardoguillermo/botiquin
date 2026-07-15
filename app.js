// ============================================================
// BOTIQUÍN — v0.01 DEV
// ============================================================
const APP_VERSION = "0.01-dev";
const STORAGE_KEY = "dev_botiquin_items";
const SNAPSHOT_KEY = "dev_botiquin_snapshots";
const MAX_SNAPSHOTS = 10;

let items = [];
let editingId = null;
let lastAction = null; // for undo
let html5QrCode = null;

// ---------- utils ----------
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0,0,0,0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / 86400000);
}

function estadoVencimiento(dateStr) {
  const d = daysUntil(dateStr);
  if (d === null) return "ok";
  if (d < 0) return "urgent";      // vencido
  if (d <= 7) return "urgent";     // vence en menos de una semana
  if (d <= 30) return "soon";      // dentro del mes (aviso)
  return "ok";
}

function fmtFecha(dateStr) {
  if (!dateStr) return "sin fecha";
  const [y,m,d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// ---------- storage ----------
function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    items = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("Error leyendo storage", e);
    items = [];
  }
}

function saveItems() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  saveSnapshot();
  render();
}

function saveSnapshot() {
  try {
    let snaps = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "[]");
    snaps.push({ t: Date.now(), data: items });
    if (snaps.length > MAX_SNAPSHOTS) snaps = snaps.slice(snaps.length - MAX_SNAPSHOTS);
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snaps));
  } catch (e) {
    console.error("Error guardando snapshot", e);
  }
}

// ---------- render ----------
function render() {
  const q = (document.getElementById("search").value || "").toLowerCase().trim();
  const filtered = items.filter(it =>
    !q || it.nombre.toLowerCase().includes(q) || (it.uso || "").toLowerCase().includes(q)
  ).sort((a,b) => {
    const da = daysUntil(a.vencimiento);
    const db = daysUntil(b.vencimiento);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });

  const list = document.getElementById("list");
  list.innerHTML = "";

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty">${items.length === 0 ? "Todavía no cargaste medicamentos." : "Sin resultados para esa búsqueda."}</div>`;
  } else {
    filtered.forEach(it => list.appendChild(renderItem(it)));
  }

  // metrics
  const total = items.length;
  const soon = items.filter(it => estadoVencimiento(it.vencimiento) === "soon").length;
  const expired = items.filter(it => estadoVencimiento(it.vencimiento) === "urgent" && daysUntil(it.vencimiento) < 0).length;
  document.getElementById("mTotal").textContent = total;
  document.getElementById("mSoon").textContent = soon;
  document.getElementById("mExpired").textContent = expired;
}

function renderItem(it) {
  const div = document.createElement("div");
  div.className = "item";
  const estado = estadoVencimiento(it.vencimiento);
  const badgeClass = estado === "urgent" ? "urgent" : estado === "soon" ? "soon" : "ok";
  const bajoMinimo = (it.minimo != null) && (Number(it.cantidad) <= Number(it.minimo));

  div.innerHTML = `
    <div class="row-top">
      <div>
        <p class="name">${escapeHtml(it.nombre)}</p>
        <p class="meta">${escapeHtml(it.uso || "sin uso especificado")} · ${it.cantidad} envase${it.cantidad === 1 ? "" : "s"}</p>
      </div>
      <span class="badge ${badgeClass}">Vence ${fmtFecha(it.vencimiento)}</span>
    </div>
    ${bajoMinimo ? `<div class="low-stock">⚠️ Stock mínimo (${it.minimo}) alcanzado</div>` : ""}
    <div class="row-actions">
      <button class="usar">− Usar</button>
      <button class="editar">Editar</button>
      <button class="baja">Dar de baja</button>
    </div>
  `;

  div.querySelector(".usar").addEventListener("click", () => usarUnidad(it.id));
  div.querySelector(".editar").addEventListener("click", () => openForm(it.id));
  div.querySelector(".baja").addEventListener("click", () => darDeBaja(it.id));

  return div;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---------- actions: usar / baja / undo ----------
function usarUnidad(id) {
  const it = items.find(i => i.id === id);
  if (!it) return;
  if (it.cantidad <= 0) return;

  const prevCantidad = it.cantidad;
  it.cantidad -= 1;
  saveItems();

  lastAction = {
    type: "usar",
    undo: () => {
      const target = items.find(i => i.id === id);
      if (target) { target.cantidad = prevCantidad; saveItems(); }
    }
  };
  showToast(`Descontado 1 envase de ${it.nombre}`);
}

function darDeBaja(id) {
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return;
  const removed = items[idx];
  items.splice(idx, 1);
  saveItems();

  lastAction = {
    type: "baja",
    undo: () => {
      items.splice(idx, 0, removed);
      saveItems();
    }
  };
  showToast(`${removed.nombre} dado de baja`);
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  document.getElementById("toastMsg").textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 6000);
}

document.getElementById("toastUndo").addEventListener("click", () => {
  if (lastAction) {
    lastAction.undo();
    lastAction = null;
  }
  document.getElementById("toast").classList.remove("show");
});

// ---------- form ----------
function openForm(id) {
  editingId = id || null;
  const it = id ? items.find(i => i.id === id) : null;

  document.getElementById("formTitle").textContent = it ? "Editar medicamento" : "Agregar medicamento";
  document.getElementById("fNombre").value = it ? it.nombre : "";
  document.getElementById("fUso").value = it ? (it.uso || "") : "";
  document.getElementById("fCantidad").value = it ? it.cantidad : 1;
  document.getElementById("fMinimo").value = it ? (it.minimo != null ? it.minimo : 1) : 1;
  document.getElementById("fVencimiento").value = it ? (it.vencimiento || "") : "";
  document.getElementById("fCodigo").value = it ? (it.codigo || "") : "";
  document.getElementById("lookupStatus").textContent = "";

  document.getElementById("formOverlay").classList.add("show");
}

function closeForm() {
  stopScanner();
  document.getElementById("formOverlay").classList.remove("show");
  editingId = null;
}

document.getElementById("fab").addEventListener("click", () => openForm(null));
document.getElementById("btnCancelForm").addEventListener("click", closeForm);

document.getElementById("btnSaveForm").addEventListener("click", () => {
  const nombre = document.getElementById("fNombre").value.trim();
  if (!nombre) { alert("Ingresá el nombre del producto"); return; }

  const data = {
    nombre,
    uso: document.getElementById("fUso").value.trim(),
    cantidad: Math.max(0, parseInt(document.getElementById("fCantidad").value, 10) || 0),
    minimo: Math.max(0, parseInt(document.getElementById("fMinimo").value, 10) || 0),
    vencimiento: document.getElementById("fVencimiento").value || null,
    codigo: document.getElementById("fCodigo").value.trim() || null,
  };

  if (editingId) {
    const it = items.find(i => i.id === editingId);
    Object.assign(it, data);
  } else {
    items.push({ id: uuid(), ...data, creado: Date.now() });
  }

  saveItems();
  closeForm();
});

document.getElementById("search").addEventListener("input", render);

// ---------- barcode scanning ----------
document.getElementById("btnScan").addEventListener("click", () => {
  const reader = document.getElementById("reader");
  const isVisible = reader.style.display === "block";
  if (isVisible) { stopScanner(); return; }

  reader.style.display = "block";
  document.getElementById("lookupStatus").textContent = "Apuntá la cámara al código de barras...";

  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 120 } },
    onScanSuccess,
    () => {} // ignore per-frame errors
  ).catch(err => {
    document.getElementById("lookupStatus").textContent = "No se pudo acceder a la cámara: " + err;
    reader.style.display = "none";
  });
});

function stopScanner() {
  const reader = document.getElementById("reader");
  if (html5QrCode) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    html5QrCode = null;
  }
  reader.style.display = "none";
}

async function onScanSuccess(decodedText) {
  document.getElementById("fCodigo").value = decodedText;
  stopScanner();
  document.getElementById("lookupStatus").textContent = "Buscando producto...";
  await lookupBarcode(decodedText);
}

async function lookupBarcode(code) {
  // Best-effort: intenta Open Food Facts / Open Products Facts.
  // No hay una base pública confiable de medicamentos AR/UY, así que
  // si no encuentra nada, se completa el nombre a mano.
  try {
    const resp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
    const data = await resp.json();
    if (data && data.status === 1 && data.product) {
      const nombre = data.product.product_name || data.product.generic_name;
      if (nombre) {
        document.getElementById("fNombre").value = nombre;
        document.getElementById("lookupStatus").textContent = "Producto encontrado, revisá el nombre.";
        return;
      }
    }
    document.getElementById("lookupStatus").textContent = "No se encontró el producto — cargalo a mano.";
  } catch (e) {
    document.getElementById("lookupStatus").textContent = "Sin conexión para buscar el producto — cargalo a mano.";
  }
}

// ---------- backup (placeholder dev) ----------
document.getElementById("btnBackup").addEventListener("click", () => {
  // TODO: integrar DriveSync real (mismo patrón que Mini HA / Stock en Casa)
  showToast("Backup a Drive: pendiente de integrar en esta versión dev");
});

// ---------- safe close ----------
window.addEventListener("beforeunload", saveSnapshot);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveSnapshot();
});

document.getElementById("btnExit").addEventListener("click", () => {
  if (confirm("¿Salir de Botiquín? Se guardó un backup local automáticamente.")) {
    saveSnapshot();
    window.close();
  }
});

// ---------- splash ----------
function updateSplashFooter() {
  const now = new Date();
  const fecha = now.toLocaleDateString('es-UY');
  const hora = now.toLocaleTimeString('es-UY', { hour12: false, hour: '2-digit', minute: '2-digit' });
  document.getElementById("splash-footer").textContent = `Botiquín · ${fecha} · ${hora} · v${APP_VERSION}`;
}

function closeSplash() {
  document.getElementById("splash").style.display = "none";
  document.getElementById("app").style.display = "block";
}

updateSplashFooter();
document.getElementById("splash").addEventListener("click", closeSplash);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.getElementById("splash").style.display !== "none") {
    closeSplash();
  }
});

// ---------- init ----------
loadItems();
render();

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
