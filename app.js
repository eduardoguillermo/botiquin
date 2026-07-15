// ============================================================
// BOTIQUÍN — v0.01 DEV
// ============================================================
const APP_VERSION = "0.05-dev";
const STORAGE_KEY = "dev_botiquin_items";
const SNAPSHOT_KEY = "dev_botiquin_snapshots";
const DRIVE_TOKEN_KEY = "dev_botiquin_drive_token";
const MAX_SNAPSHOTS = 10;

const DRIVE_CLIENT_ID = "1049169592532-is5j1j4s1bmgrc9tsq48slrgul8fbj17.apps.googleusercontent.com";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FOLDER_NAME = "Botiquin";
const DRIVE_FILE_NAME = "data.json";

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

function unidadesTotales(it) {
  const upe = Math.max(1, Number(it.unidadesPorEnvase) || 1);
  return Number(it.cantidad) * upe;
}

function activos() {
  return items.filter(it => !it.deleted);
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
  if (typeof DriveSync !== "undefined" && DriveSync.conectado()) {
    DriveSync.sync(); // fire and forget, en segundo plano
  }
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
  const base = activos();
  const filtered = base.filter(it =>
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
    list.innerHTML = `<div class="empty">${base.length === 0 ? "Todavía no cargaste medicamentos." : "Sin resultados para esa búsqueda."}</div>`;
  } else {
    filtered.forEach(it => list.appendChild(renderItem(it)));
  }

  // metrics
  const total = base.length;
  const soon = base.filter(it => estadoVencimiento(it.vencimiento) === "soon").length;
  const expired = base.filter(it => estadoVencimiento(it.vencimiento) === "urgent" && daysUntil(it.vencimiento) < 0).length;
  document.getElementById("mTotal").textContent = total;
  document.getElementById("mSoon").textContent = soon;
  document.getElementById("mExpired").textContent = expired;
}

function renderItem(it) {
  const div = document.createElement("div");
  div.className = "item";
  const estado = estadoVencimiento(it.vencimiento);
  const badgeClass = estado === "urgent" ? "urgent" : estado === "soon" ? "soon" : "ok";
  const totalU = unidadesTotales(it);
  const bajoMinimo = (it.minimo != null) && (totalU <= Number(it.minimo));
  const upe = Math.max(1, Number(it.unidadesPorEnvase) || 1);
  const detalleUnidades = upe > 1 ? ` (${totalU} unidades)` : "";

  div.innerHTML = `
    <div class="row-top">
      <div>
        <p class="name">${escapeHtml(it.nombre)}</p>
        <p class="meta">${escapeHtml(it.uso || "sin uso especificado")} · ${it.cantidad} envase${it.cantidad === 1 ? "" : "s"}${detalleUnidades}</p>
      </div>
      <span class="badge ${badgeClass}">Vence ${fmtFecha(it.vencimiento)}</span>
    </div>
    ${bajoMinimo ? `<div class="low-stock">⚠️ Stock mínimo (${it.minimo} unidades) alcanzado</div>` : ""}
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
  it.lastModified = Date.now();
  saveItems();

  lastAction = {
    type: "usar",
    undo: () => {
      const target = items.find(i => i.id === id);
      if (target) { target.cantidad = prevCantidad; target.lastModified = Date.now(); saveItems(); }
    }
  };
  showToast(`Descontado 1 envase de ${it.nombre}`);
}

// Borrado lógico (tombstone): se mantiene el registro con deleted=true
// para que el merge con Drive respete la baja en el otro dispositivo.
function darDeBaja(id) {
  const it = items.find(i => i.id === id);
  if (!it) return;
  it.deleted = true;
  it.lastModified = Date.now();
  saveItems();

  lastAction = {
    type: "baja",
    undo: () => {
      const target = items.find(i => i.id === id);
      if (target) { target.deleted = false; target.lastModified = Date.now(); saveItems(); }
    }
  };
  showToast(`${it.nombre} dado de baja`);
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
  document.getElementById("fUnidadesPorEnvase").value = it ? (it.unidadesPorEnvase || 1) : 1;
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
    unidadesPorEnvase: Math.max(1, parseInt(document.getElementById("fUnidadesPorEnvase").value, 10) || 1),
    minimo: Math.max(0, parseInt(document.getElementById("fMinimo").value, 10) || 0),
    vencimiento: document.getElementById("fVencimiento").value || null,
    codigo: document.getElementById("fCodigo").value.trim() || null,
    lastModified: Date.now(),
  };

  if (editingId) {
    const it = items.find(i => i.id === editingId);
    Object.assign(it, data);
  } else {
    items.push({ id: uuid(), ...data, creado: Date.now(), deleted: false });
  }

  saveItems();
  closeForm();
});

document.getElementById("search").addEventListener("input", render);

// ---------- ayuda ----------
document.getElementById("btnHelp").addEventListener("click", () => {
  document.getElementById("helpOverlay").classList.add("show");
});
document.getElementById("btnCloseHelp").addEventListener("click", () => {
  document.getElementById("helpOverlay").classList.remove("show");
});

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

// ============================================================
// DRIVE SYNC — carpeta visible "Botiquin", archivo data.json
// Merge por uuid + lastModified (mismo patrón que gmMergeMovimientos)
// ============================================================
const DriveSync = {
  token: null,
  tokenExpiry: 0,
  tokenClient: null,
  folderId: null,
  fileId: null,
  _lock: Promise.resolve(), // mutex simple para evitar carreras

  init() {
    try {
      const saved = JSON.parse(localStorage.getItem(DRIVE_TOKEN_KEY) || "null");
      if (saved && saved.token && saved.expiry > Date.now()) {
        this.token = saved.token;
        this.tokenExpiry = saved.expiry;
        this.folderId = saved.folderId || null;
        this.fileId = saved.fileId || null;
      }
    } catch (e) {}
    this._updateDriveBtn();
  },

  _updateDriveBtn() {
    const btn = document.getElementById("btnDrive");
    if (this.conectado()) {
      btn.textContent = "🟢";
      btn.title = "Drive conectado";
    } else {
      btn.textContent = "🔌";
      btn.title = "Conectar Google Drive";
    }
  },

  conectado() {
    return !!(this.token && this.tokenExpiry > Date.now());
  },

  _persistToken() {
    localStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify({
      token: this.token, expiry: this.tokenExpiry,
      folderId: this.folderId, fileId: this.fileId,
    }));
  },

  conectar() {
    return new Promise((resolve, reject) => {
      if (this.conectado()) { resolve(); return; }
      if (typeof google === "undefined" || !google.accounts) {
        reject(new Error("Google Identity Services no cargó todavía"));
        return;
      }
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CLIENT_ID,
        scope: DRIVE_SCOPES,
        callback: (resp) => {
          if (resp.error) { reject(resp); return; }
          this.token = resp.access_token;
          this.tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
          this._persistToken();
          this._updateDriveBtn();
          resolve();
        },
      });
      this.tokenClient.requestAccessToken();
    });
  },

  _authHeader() {
    return { Authorization: `Bearer ${this.token}` };
  },

  async ensureFolder() {
    if (this.folderId) return this.folderId;
    const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, { headers: this._authHeader() });
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      this.folderId = data.files[0].id;
    } else {
      const create = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { ...this._authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
      });
      const created = await create.json();
      this.folderId = created.id;
    }
    this._persistToken();
    return this.folderId;
  },

  async ensureFile() {
    if (this.fileId) return this.fileId;
    await this.ensureFolder();
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and '${this.folderId}' in parents and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, { headers: this._authHeader() });
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      this.fileId = data.files[0].id;
    } else {
      this.fileId = null; // se crea recién en el primer upload
    }
    this._persistToken();
    return this.fileId;
  },

  async descargar() {
    await this.ensureFile();
    if (!this.fileId) return null;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`, { headers: this._authHeader() });
    if (!res.ok) return null;
    try { return await res.json(); } catch (e) { return null; }
  },

  async subir(payload, keepalive) {
    await this.ensureFolder();
    const boundary = "botiquin_boundary";
    const metadata = this.fileId
      ? { name: DRIVE_FILE_NAME }
      : { name: DRIVE_FILE_NAME, parents: [this.folderId] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n` +
      `--${boundary}--`;

    const url = this.fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const res = await fetch(url, {
      method: this.fileId ? "PATCH" : "POST",
      headers: { ...this._authHeader(), "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      keepalive: !!keepalive,
    });
    const data = await res.json();
    if (!this.fileId && data.id) { this.fileId = data.id; this._persistToken(); }
    return data;
  },

  // Merge por uuid + lastModified: se queda con la versión más nueva de cada ítem.
  merge(local, remote) {
    const byId = new Map();
    (local || []).forEach(it => byId.set(it.id, it));
    (remote || []).forEach(rIt => {
      const lIt = byId.get(rIt.id);
      if (!lIt || (rIt.lastModified || 0) > (lIt.lastModified || 0)) {
        byId.set(rIt.id, rIt);
      }
    });
    return Array.from(byId.values());
  },

  // Encola sync para evitar carreras si se disparan varios guardados seguidos
  async sync(keepalive) {
    this._lock = this._lock.then(() => this._syncNow(keepalive)).catch((e) => console.error("Drive sync error", e));
    return this._lock;
  },

  async _syncNow(keepalive) {
    if (!this.conectado()) return;
    const remoteData = await this.descargar();
    const remoteItems = remoteData && remoteData.items ? remoteData.items : [];
    const merged = this.merge(items, remoteItems);
    items = merged;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    render();
    await this.subir({ items, updatedAt: Date.now() }, keepalive);
  },
};

DriveSync.init();

document.getElementById("btnDrive").addEventListener("click", async () => {
  if (DriveSync.conectado()) {
    showToast("Drive ya está conectado");
    return;
  }
  try {
    await DriveSync.conectar();
    showToast("Google Drive conectado");
    await DriveSync.sync();
    showToast("Sincronizado con Drive");
  } catch (e) {
    showToast("No se pudo conectar a Drive");
  }
});

document.getElementById("btnBackup").addEventListener("click", async () => {
  if (!DriveSync.conectado()) {
    showToast("Conectá Drive primero (🔌)");
    return;
  }
  showToast("Sincronizando con Drive...");
  await DriveSync.sync();
  showToast("Backup a Drive completo");
});

// ---------- safe close ----------
window.addEventListener("beforeunload", saveSnapshot);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveSnapshot();
    if (typeof DriveSync !== "undefined" && DriveSync.conectado()) {
      DriveSync.sync(true); // keepalive: la subida sigue aunque se suspenda la pestaña
    }
  }
});

document.getElementById("btnExit").addEventListener("click", async () => {
  if (!confirm("¿Salir de Botiquín? Se va a guardar un backup en Drive antes de cerrar.")) return;

  saveSnapshot();

  if (!DriveSync.conectado()) {
    alert("Drive no está conectado, así que no puedo hacer backup antes de salir. Tocá 🔌 para conectar Drive, o volvé a intentar salir si igual querés forzarlo.");
    return; // no cierra: falta la condición para el backup
  }

  try {
    await DriveSync.sync();
    alert("Backup guardado en Drive. Cerrando Botiquín.");
    window.close();
  } catch (e) {
    console.error("Error sincronizando al salir", e);
    alert("No se pudo guardar el backup en Drive (revisá conexión a internet). La app sigue abierta, reintentá salir cuando se resuelva.");
    // no cierra: hubo error en el backup
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
if (DriveSync.conectado()) {
  DriveSync.sync();
}

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
