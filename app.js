'use strict';
/* Verificación de activos fijos · L'Arkad · Cortyvis 2026
   App web sin conexión. Los datos del cliente se cargan desde un paquete local y se guardan solo en este teléfono. */
const APP_VER = '1.0.0';
const $ = s => document.querySelector(s);
const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
const now = () => new Date().toISOString();
const fmtFecha = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('es-EC') + ' ' + d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }); };
const money = n => (n === '' || n == null || isNaN(+n)) ? '—' : 'USD ' + (+n).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ESTADOS = { PENDIENTE: 'Pendiente', EN_PROCESO: 'En proceso', CORROBORADA: 'Corroborada', ETIQUETADA_PEND: 'Etiquetada · pend. aprobación', CERRADA: 'Cerrada', NO_ENCONTRADA: 'No encontrada' };
const VEST = { ORIGINAL: 'Por confirmar', CONFIRMADO: 'Confirmado', PROPUESTO: 'Propuesto', APROBADO: 'Aprobado', RECHAZADO: 'Rechazado', REEMPLAZADO: 'Reemplazado' };
const ROLES = { PRINCIPAL: 'Principal', MEJORA: 'Mejora', ACCESORIO: 'Accesorio', UNIDAD: 'Unidad de cuenta agrupada', MODULO: 'Módulo' };
const MOTIVOS = ['La serie de la placa coincide con esta cuenta', 'Por descripción, marca y modelo', 'Por ubicación / centro de costo', 'Informado por técnico de Cortyvis', 'Máquina encontrada en planta (no estaba vinculada)', 'Otro (detallar)'];
const EST_FIS = ['ACTIVO', 'INACTIVO', 'CHATARRA', 'DESARMADA'];

/* ---------------- IndexedDB ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('cortyvis-activos', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('m', { keyPath: 'id' }); d.createObjectStore('fotos'); d.createObjectStore('log', { autoIncrement: true }); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(store, key) { return this.tx(store, 'readonly', s => s.get(key)); },
  put(store, val, key) { return this.tx(store, 'readwrite', s => key === undefined ? s.put(val) : s.put(val, key)); },
  del(store, key) { return this.tx(store, 'readwrite', s => s.delete(key)); },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
  keys(store) { return this.tx(store, 'readonly', s => s.getAllKeys()); },
};

/* ---------------- Estado global ---------------- */
const S = { set: {}, pkg: null, cuentas: new Map(), maqPkg: new Map(), st: new Map(), stack: [], coordHasta: 0, urls: new Map(), filtroSec: 'TODAS', contab: { q: '', otros: false, vendidas: false, ubic: '' } };

async function saveSet() { await DB.put('kv', S.set, 'settings'); }
async function log(id, accion, detalle) { await DB.put('log', { ts: now(), verificador: S.set.verificador || '', planta: S.set.planta || '', id, accion, detalle: detalle || '' }); }

function indexar() {
  S.cuentas = new Map(); S.maqPkg = new Map();
  if (!S.pkg) return;
  S.pkg.cuentas.forEach(c => S.cuentas.set(c.cod, c));
  S.pkg.maquinas.forEach(m => S.maqPkg.set(m.id, m));
}
function base(id) { const m = S.maqPkg.get(id); if (m) return m; const st = S.st.get(id); return st && st.base ? st.base : null; }
function maquinasPlanta() {
  const out = S.pkg ? S.pkg.maquinas.slice() : [];
  for (const st of S.st.values()) if (st.nuevo && st.planta === S.set.planta) out.push(st.base);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
function secciones() {
  const map = new Map();
  maquinasPlanta().forEach(b => { if (!map.has(b.seccion)) map.set(b.seccion, { id: b.seccion, nombres: new Set(), maq: [] }); const s = map.get(b.seccion); if (b.seccionNombre) s.nombres.add(b.seccionNombre); s.maq.push(b); });
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id)).map(s => ({ id: s.id, nombre: [...s.nombres].join(' / '), maq: s.maq }));
}
function defState(b) {
  return { id: b.id, planta: b.planta, seccion: b.seccion, nuevo: false, base: null, existe: null, placa: { serie: '', marca: '', modelo: '', anio: '', ilegible: false, motivoIlegible: '' },
    modeloFoto: null, estadoFisico: '', ubicacionOk: null, ubicacionNueva: '', obs: '', tecnico: { req: false, motivo: '' },
    vinculos: b.codContOrig ? [{ cod: b.codContOrig, rol: 'PRINCIPAL', unidad: '', estado: 'ORIGINAL', origen: 'LEVANTAMIENTO', motivo: '', reemplaza: '', ts: '' }] : [],
    sinCuenta: false, moduloDe: '', codNuevo: '', sticker: { escaneado: false, ts: '' }, fotos: {}, verificador: '', actualizado: '', touched: false };
}
function getSt(id) { let st = S.st.get(id); if (!st) { const b = base(id); if (!b) return null; st = defState(b); } return st; }
async function guardar(st, accion, detalle) {
  st.touched = true; st.actualizado = now(); st.verificador = S.set.verificador || '';
  S.st.set(st.id, st); await DB.put('m', st);
  if (accion) await log(st.id, accion, detalle);
}
const activos = st => st.vinculos.filter(v => v.estado !== 'REEMPLAZADO' && v.estado !== 'RECHAZADO');

function estadoDe(st) {
  if (!st || !st.touched) return 'PENDIENTE';
  if (st.existe === false) return 'NO_ENCONTRADA';
  return faltantes(st).length ? 'EN_PROCESO' : (st.sticker.escaneado && st.fotos.STICKER ? ((st.vinculos.some(v => v.estado === 'PROPUESTO') || st.tecnico.req) ? 'ETIQUETADA_PEND' : 'CERRADA') : 'CORROBORADA');
}
function faltantes(st) {
  const f = [];
  if (st.existe !== true) f.push('confirmar que existe');
  if (!(st.fotos.PLACA || (st.placa.ilegible && st.placa.motivoIlegible.trim()))) f.push('foto de la placa (o motivo de placa ilegible)');
  if (st.nuevo ? !st.fotos.MODELO : !(st.modeloFoto === 'ACTUAL' || (st.modeloFoto === 'NUEVA' && st.fotos.MODELO))) f.push('foto del modelo');
  if (!st.estadoFisico) f.push('estado físico');
  if (activos(st).length ? st.vinculos.some(v => v.estado === 'ORIGINAL') : !st.sinCuenta) f.push(activos(st).length ? 'confirmar o cambiar la cuenta contable' : 'vincular cuenta o marcar "sin cuenta"');
  if (st.nuevo && !st.fotos.PROVISIONAL && !st.sticker.escaneado) f.push('foto del rótulo provisional');
  return f;
}

/* Índice de cuentas vinculadas (levantamiento + cambios de este teléfono) */
function vinculadas() {
  const map = new Map(); const add = (cod, id) => { if (!map.has(cod)) map.set(cod, new Set()); map.get(cod).add(id); };
  (S.pkg ? S.pkg.vinculosLevantamiento || [] : []).forEach(v => { if (!S.st.has(v.id)) add(v.cod, v.id); });
  for (const st of S.st.values()) activos(st).forEach(v => add(v.cod, st.id));
  return map;
}
function semaforo(st, b, c) {
  if (!c) return 'gris';
  const serie = norm(st.placa.serie || b.serie), cs = norm(c.serie);
  if (serie && cs) return (serie === cs || (serie.length >= 4 && cs.length >= 4 && (serie.includes(cs) || cs.includes(serie)))) ? 'verde' : 'rojo';
  const mk = norm(st.placa.marca || b.marca), cm = norm(c.marca || c.fabricante), md = norm(st.placa.modelo || b.modelo), cmd = norm(c.modelo);
  const okM = mk && cm && (mk.includes(cm) || cm.includes(mk)), okMd = md && cmd && (md.includes(cmd) || cmd.includes(md));
  if (okM || okMd) return 'amarillo';
  if (mk && cm && md && cmd) return 'rojo';
  return 'gris';
}
function alertasCuenta(c, st, v, vinc) {
  const a = [];
  if (!c) { a.push(['bad', 'La cuenta no existe en la Consulta de Cortyvis.']); return a; }
  if (c.estadoLibros === 'VENDIDO') a.push(['bad', 'Vendido según libros, pero presente en planta (fecha de venta ' + esc(c.fVenta) + '). Requiere aprobación del coordinador.']);
  if (c.grupo !== '0003' && c.grupo !== '0004') a.push(['warn', 'Fuera del universo principal: grupo ' + esc(c.grupo) + ' ' + esc(c.grupoNombre || '') + '. Requiere aprobación.']);
  if (c.estadoLibros === 'DEPRECIADO') a.push(['info', 'Totalmente depreciado: vida útil cumplida el ' + esc(c.fDesinc) + '. Verificar igual.']);
  if (c.estadoLibros === 'SIN MODULO') a.push(['warn', 'La cuenta no figura en el Módulo de activos.']);
  const otros = [...(vinc.get(c.cod) || [])].filter(x => x !== st.id);
  if (v.rol !== 'UNIDAD' && otros.length) a.push(['warn', 'Esta cuenta también está vinculada a: ' + otros.map(esc).join(', ') + '. Si son varias máquinas de una misma cuenta, use el rol "Unidad".']);
  if (c.cantidad > 1 || v.rol === 'UNIDAD') { const n = (vinc.get(c.cod) || new Set()).size; a.push([n === c.cantidad ? 'info' : 'warn', 'Cuenta agrupada: ' + n + ' encontrada(s) de ' + c.cantidad + ' según libros.']); }
  return a;
}
const requiereAprob = c => !c || c.estadoLibros === 'VENDIDO' || c.estadoLibros === 'SIN MODULO' || (c.grupo !== '0003' && c.grupo !== '0004');

/* ---------------- Fotos ---------------- */
function comprimir(file, max = 1600, q = 0.8) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight; const k = Math.min(1, max / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url); cv.toBlob(b => b ? res(b) : rej(new Error('No se pudo procesar la foto')), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Formato de foto no soportado')); };
    img.src = url;
  });
}
function tomarFoto(id, tipo) {
  const inp = $('#fileCam'); inp.value = '';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      toast('Guardando foto…');
      const blob = await comprimir(f);
      const key = id + '_' + tipo;
      await DB.put('fotos', { blob, ts: now(), exportado: false }, key);
      if (S.urls.has(key)) { URL.revokeObjectURL(S.urls.get(key)); S.urls.delete(key); }
      const st = getSt(id); st.fotos[tipo] = true;
      if (tipo === 'MODELO' && !st.nuevo) st.modeloFoto = 'NUEVA';
      await guardar(st, 'FOTO_' + tipo, Math.round(blob.size / 1024) + ' KB');
      toast('Foto guardada'); render();
    } catch (e) { alerta('No se pudo guardar la foto', esc(e.message)); }
  };
  inp.click();
}
async function urlFoto(key) {
  if (S.urls.has(key)) return S.urls.get(key);
  const r = await DB.get('fotos', key); if (!r) return '';
  const u = URL.createObjectURL(r.blob); S.urls.set(key, u); return u;
}

/* ---------------- UI helpers ---------------- */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 2200); }
function modal(html, onMount) {
  const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = '<div class="sheet">' + html + '</div>';
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  document.body.appendChild(m); if (onMount) onMount(m); return m;
}
function alerta(titulo, html) { const m = modal('<h2>' + esc(titulo) + '</h2><div style="margin-bottom:12px">' + html + '</div><button class="btn block" data-x>Entendido</button>'); m.querySelector('[data-x]').onclick = () => m.remove(); }
function confirmar(titulo, html, okTxt) {
  return new Promise(res => {
    const m = modal('<h2>' + esc(titulo) + '</h2><div style="margin-bottom:12px">' + html + '</div><div class="row"><button class="btn sec grow" data-n>Cancelar</button><button class="btn grow" data-s>' + esc(okTxt || 'Aceptar') + '</button></div>');
    m.querySelector('[data-n]').onclick = () => { m.remove(); res(false); };
    m.querySelector('[data-s]').onclick = () => { m.remove(); res(true); };
  });
}
function pedirMotivo(titulo, extra) {
  return new Promise(res => {
    const m = modal('<h2>' + esc(titulo) + '</h2>' + (extra || '') + '<label class="f">Motivo</label><select id="mSel">' + MOTIVOS.map(x => '<option>' + esc(x) + '</option>').join('') + '</select><label class="f">Detalle</label><textarea id="mTxt" placeholder="Explique brevemente"></textarea><div class="row" style="margin-top:12px"><button class="btn sec grow" data-n>Cancelar</button><button class="btn grow" data-s>Guardar</button></div>');
    m.querySelector('[data-n]').onclick = () => { m.remove(); res(null); };
    m.querySelector('[data-s]').onclick = () => {
      const sel = m.querySelector('#mSel').value, txt = m.querySelector('#mTxt').value.trim();
      if (sel.startsWith('Otro') && !txt) { toast('Detalle el motivo'); return; }
      m.remove(); res(txt ? sel + ': ' + txt : sel);
    };
  });
}
function chip(e) { return '<span class="chip st-' + e + '">' + ESTADOS[e] + '</span>'; }
function setHeader(t, sub) { $('#hTitle').textContent = t; $('#hSub').textContent = sub || ((S.set.planta ? 'Planta ' + S.set.planta.slice(1) : '') + (S.set.verificador ? ' · ' + S.set.verificador : '')); $('#hBack').classList.toggle('hide', S.stack.length < 2); }
function go(name, params, replace) { if (replace) S.stack.pop(); S.stack.push({ name, params: params || {} }); render(); window.scrollTo(0, 0); }
function back() { if (S.stack.length > 1) { S.stack.pop(); render(); } }
function tabRoot(name) { S.stack = [{ name, params: {} }]; render(); window.scrollTo(0, 0); }

/* ---------------- Render ---------------- */
async function render() {
  const listo = S.pkg && S.set.verificador;
  if (!listo) S.stack = [{ name: 'inicio', params: {} }];
  const v = S.stack[S.stack.length - 1];
  $('#tabs').classList.toggle('hide', !listo);
  $('#fab').classList.toggle('hide', !listo || !['secciones', 'seccion', 'ficha'].includes(v.name));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === S.stack[0].name));
  const views = { inicio: vInicio, ajustes: vAjustes, secciones: vSecciones, seccion: vSeccion, ficha: vFicha, contabilidad: vContabilidad, coordinador: vCoordinador, exportar: vExportar };
  await views[v.name](v.params);
}

/* ----- Inicio / configuración ----- */
function vInicio() {
  setHeader('Verificación de activos', 'L´Arkad · Cortyvis 2026');
  const app = $('#app');
  app.innerHTML = `
  <div class="card"><h3>1. Cargar el paquete de la planta</h3>
    <p class="muted">Archivo <b>Paquete_Cortyvis_P1.json</b> o <b>P2.json</b>. Cárguelo con Wi-Fi; después la app funciona sin internet.</p>
    ${S.pkg ? `<div class="alert info">Paquete cargado: Planta ${esc(S.pkg.meta.planta.slice(1))} · ${S.pkg.meta.maquinas} máquinas · ${S.pkg.meta.cuentas} cuentas · generado ${esc(S.pkg.meta.generado)}</div>` : ''}
    <button class="btn ${S.pkg ? 'sec' : ''} block" id="bPkg" style="margin-top:10px">${S.pkg ? 'Cargar otro paquete' : 'Elegir archivo del paquete'}</button>
  </div>
  <div class="card"><h3>2. Nombre del verificador</h3>
    <input type="text" id="iVer" placeholder="Ej.: Verificador 1 · Nombre" value="${esc(S.set.verificador || '')}">
    <button class="btn block" id="bVer" style="margin-top:10px" ${S.pkg ? '' : 'disabled'}>Empezar</button>
  </div>
  <div class="card"><h3>Restaurar un avance</h3><p class="muted">Solo si cambió de teléfono o borró los datos: elija el ZIP de una exportación anterior.</p>
    <button class="btn sec block" id="bRest">Restaurar desde ZIP</button></div>
  <p class="muted" style="text-align:center">Versión ${APP_VER} · Los datos se guardan solo en este teléfono.</p>`;
  $('#bPkg').onclick = cargarPaquete;
  $('#bRest').onclick = restaurar;
  $('#bVer').onclick = async () => {
    const n = $('#iVer').value.trim(); if (!n) { toast('Escriba su nombre'); return; }
    S.set.verificador = n; await saveSet(); tabRoot('secciones');
  };
}
function elegirArchivo(accept) {
  return new Promise(res => { const inp = $('#fileAny'); inp.value = ''; inp.accept = accept; inp.onchange = () => res(inp.files[0] || null); inp.click(); });
}
async function cargarPaquete() {
  const f = await elegirArchivo('.json,application/json'); if (!f) return;
  try {
    toast('Leyendo paquete…');
    const pkg = JSON.parse(await f.text());
    if (!pkg.meta || pkg.meta.tipo !== 'CORTYVIS-PAQUETE') throw new Error('El archivo no es un paquete de la app.');
    await DB.put('kv', pkg, 'pkg_' + pkg.meta.planta);
    S.set.planta = pkg.meta.planta; S.set.paquetes = [...new Set([...(S.set.paquetes || []), pkg.meta.planta])]; await saveSet();
    S.pkg = pkg; indexar(); toast('Paquete de la Planta ' + pkg.meta.planta.slice(1) + ' cargado'); render();
  } catch (e) { alerta('No se pudo cargar el paquete', esc(e.message)); }
}
function vAjustes() {
  setHeader('Ajustes');
  const otras = (S.set.paquetes || []).filter(p => p !== S.set.planta);
  $('#app').innerHTML = `
  <div class="card"><h3>Verificador</h3><input type="text" id="iVer" value="${esc(S.set.verificador || '')}"><button class="btn sec block" id="bVer" style="margin-top:8px">Guardar nombre</button></div>
  <div class="card"><h3>Planta activa: ${esc(S.set.planta || '')}</h3>
    ${otras.map(p => `<button class="btn sec block" data-pl="${p}" style="margin-bottom:8px">Cambiar a la Planta ${p.slice(1)}</button>`).join('')}
    <button class="btn sec block" id="bPkg">Cargar otro paquete</button></div>
  <div class="card"><h3>Respaldo</h3><button class="btn sec block" id="bRest">Restaurar desde ZIP</button></div>
  <div class="card"><h3>Almacenamiento</h3><p class="muted" id="stor">Calculando…</p></div>
  <p class="muted" style="text-align:center">Versión ${APP_VER}</p>`;
  $('#bVer').onclick = async () => { const n = $('#iVer').value.trim(); if (n) { S.set.verificador = n; await saveSet(); toast('Guardado'); setHeader('Ajustes'); } };
  $('#bPkg').onclick = cargarPaquete; $('#bRest').onclick = restaurar;
  document.querySelectorAll('[data-pl]').forEach(b => b.onclick = async () => { const p = await DB.get('kv', 'pkg_' + b.dataset.pl); if (!p) return; S.pkg = p; S.set.planta = b.dataset.pl; await saveSet(); indexar(); tabRoot('secciones'); });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { $('#stor').textContent = 'Usado: ' + (e.usage / 1048576).toFixed(1) + ' MB de ' + (e.quota / 1048576).toFixed(0) + ' MB disponibles.'; });
}

/* ----- Secciones ----- */
function conteo(lista) {
  const c = { PENDIENTE: 0, EN_PROCESO: 0, CORROBORADA: 0, ETIQUETADA_PEND: 0, CERRADA: 0, NO_ENCONTRADA: 0 };
  lista.forEach(b => c[estadoDe(S.st.get(b.id))]++); return c;
}
function barra(c, total) {
  const seg = [['CERRADA', '#2E7D4F'], ['ETIQUETADA_PEND', '#D98E2B'], ['CORROBORADA', '#3B82B5'], ['NO_ENCONTRADA', '#B3261E'], ['EN_PROCESO', '#E0B54A']];
  return '<div class="bar">' + seg.map(([k, col]) => c[k] ? `<i style="width:${100 * c[k] / total}%;background:${col}"></i>` : '').join('') + '</div>';
}
function vSecciones() {
  setHeader('Planta ' + S.set.planta.slice(1));
  const secs = secciones(), todas = maquinasPlanta(), c = conteo(todas);
  const cierres = S.set.secciones || {};
  $('#app').innerHTML = `
  <div class="card"><div class="row"><div class="grow"><b>${todas.length} máquinas</b> <span class="muted">· ${c.CERRADA} cerradas · ${c.CORROBORADA + c.ETIQUETADA_PEND} corroboradas · ${c.NO_ENCONTRADA} no encontradas · ${c.PENDIENTE + c.EN_PROCESO} por revisar</span></div><button class="btn sec small" id="bAj">Ajustes</button></div>
    <div style="margin-top:8px">${barra(c, todas.length)}</div>
    <input type="search" id="q" placeholder="Buscar por código, código L´Arkad, serie o descripción" style="margin-top:10px">
    <div id="res" class="list"></div></div>
  <div class="card list">${secs.map(s => { const k = conteo(s.maq); const ci = cierres[S.set.planta + '-' + s.id] || {};
    return `<div class="secitem" data-sec="${s.id}"><span class="n">${s.id}</span><div class="grow"><div><b>${esc(s.nombre)}</b> ${ci.final ? '<span class="tag">Cierre final</span>' : ci.parcial ? '<span class="tag">Cierre parcial</span>' : ''}</div>
      <div class="muted">${s.maq.length} máq. · ${k.CERRADA} cerradas · ${k.PENDIENTE + k.EN_PROCESO} por revisar</div><div style="margin-top:5px">${barra(k, s.maq.length)}</div></div><span>›</span></div>`; }).join('')}</div>`;
  $('#bAj').onclick = () => go('ajustes');
  document.querySelectorAll('[data-sec]').forEach(e => e.onclick = () => go('seccion', { sec: e.dataset.sec }));
  $('#q').oninput = () => {
    const q = norm($('#q').value); const r = $('#res');
    if (q.length < 2) { r.innerHTML = ''; return; }
    const hits = todas.filter(b => [b.id, b.codOrig, b.serie, b.desc, b.codContOrig, b.marca].some(x => norm(x).includes(q))).slice(0, 25);
    r.innerHTML = hits.map(itemMaq).join('') || '<p class="muted">Sin resultados</p>'; ligarItems(r);
  };
}
function itemMaq(b) {
  const st = S.st.get(b.id), e = estadoDe(st);
  const alerta = st && (st.tecnico.req || st.vinculos.some(v => v.estado === 'PROPUESTO')) ? ' ⚠' : '';
  return `<div class="it" data-id="${esc(b.id)}">${b.thumb ? `<img src="${b.thumb}" alt="">` : '<img alt="">'}<div class="grow"><div><b>${esc(b.id)}</b>${st && st.nuevo ? '<span class="tag">Nueva</span>' : ''}${alerta}</div><div class="muted">${esc(b.desc || '(sin descripción)')} · ${esc(b.marca || '')} ${esc(b.serie ? '· S/N ' + b.serie : '')}</div></div>${chip(e)}</div>`;
}
function ligarItems(root) { root.querySelectorAll('[data-id]').forEach(e => e.onclick = () => go('ficha', { id: e.dataset.id })); }
function vSeccion(p) {
  const sec = secciones().find(s => s.id === p.sec) || { id: p.sec, nombre: '', maq: [] };
  setHeader(sec.id + ' · ' + sec.nombre);
  const f = S.filtroSec;
  const filtrar = b => { const st = S.st.get(b.id), e = estadoDe(st);
    if (f === 'PEND') return e === 'PENDIENTE' || e === 'EN_PROCESO';
    if (f === 'ALERT') return st && (st.tecnico.req || st.vinculos.some(v => v.estado === 'PROPUESTO') || e === 'CORROBORADA' || e === 'ETIQUETADA_PEND');
    if (f === 'CERR') return e === 'CERRADA' || e === 'NO_ENCONTRADA';
    return true; };
  const lista = sec.maq.filter(filtrar);
  $('#app').innerHTML = `
  <div class="seg" style="margin-bottom:10px">${[['TODAS', 'Todas'], ['PEND', 'Por revisar'], ['ALERT', 'Seguimiento'], ['CERR', 'Cerradas']].map(([k, t]) => `<button data-f="${k}" class="${f === k ? 'on' : ''}">${t}</button>`).join('')}</div>
  <div class="card list" id="lst">${lista.map(itemMaq).join('') || '<p class="muted">No hay máquinas en este filtro.</p>'}</div>
  <button class="btn sec block" id="bNueva">+ Registrar máquina nueva en ${esc(sec.id)}</button>`;
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.filtroSec = b.dataset.f; render(); });
  ligarItems($('#lst'));
  $('#bNueva').onclick = () => nuevaMaquina(sec.id, sec.nombre);
}
function siguienteId(sec) {
  let max = 0; maquinasPlanta().filter(b => b.seccion === sec).forEach(b => { const n = parseInt(b.id.split('-')[2], 10); if (n < 900 && n > max) max = n; });
  return S.set.planta + '-' + sec + '-' + String(max + 1).padStart(4, '0');
}
async function nuevaMaquina(sec, nombre, cuenta) {
  const id = siguienteId(sec);
  const ok = await confirmar('Registrar máquina nueva', `Se asignará el código <b>${esc(id)}</b> en la sección ${esc(sec)}.${cuenta ? '<br>Quedará vinculada a la cuenta <b>' + esc(cuenta.cod) + '</b> ' + esc(cuenta.nombre) + ' (propuesto).' : ''}<br><br>Escriba ese número en una cinta y péguela en la máquina; luego tome la foto del rótulo provisional.`, 'Registrar');
  if (!ok) return;
  const b = { id, planta: S.set.planta, seccion: sec, seccionNombre: nombre || '', codOrig: '', codContOrig: '', desc: cuenta ? cuenta.nombre : '', marca: cuenta ? cuenta.marca : '', modelo: cuenta ? cuenta.modelo : '', anio: '', serie: '', pais: '', estado: '', thumb: '' };
  const st = defState(b); st.nuevo = true; st.base = b; st.existe = true;
  if (cuenta) st.vinculos.push({ cod: cuenta.cod, rol: 'PRINCIPAL', unidad: '', estado: 'PROPUESTO', origen: 'NUEVO', motivo: 'Máquina encontrada en planta (Buscar en contabilidad)', reemplaza: '', ts: now() });
  await guardar(st, 'MAQUINA_NUEVA', cuenta ? 'Vinculada a ' + cuenta.cod : '');
  go('ficha', { id });
}

/* ----- Ficha ----- */
async function vFicha(p) {
  const id = p.id, b = base(id); if (!b) { back(); return; }
  const st = getSt(id), e = estadoDe(S.st.get(id) ? st : null), vinc = vinculadas();
  setHeader(id, b.seccion + ' · ' + (b.seccionNombre || ''));
  const fu = {}; for (const t of ['PLACA', 'MODELO', 'STICKER', 'PROVISIONAL']) fu[t] = st.fotos[t] ? await urlFoto(id + '_' + t) : '';
  const falt = S.st.has(id) ? faltantes(st) : [];
  const vis = st.vinculos.filter(v => v.estado !== 'RECHAZADO');
  const inp = (k, lbl, val, dis) => `<div><label class="f">${lbl}</label><input type="text" data-k="${k}" value="${esc(val)}" ${dis ? 'disabled' : ''}></div>`;
  const tarjetaV = (v, i) => {
    const c = S.cuentas.get(v.cod); const sem = semaforo(st, b, c); const al = v.estado === 'REEMPLAZADO' ? [] : alertasCuenta(c, st, v, vinc);
    const fila = (lbl, a, bb) => { const na = norm(a), nb = norm(bb); const cls = na && nb ? (na === nb || na.includes(nb) || nb.includes(na) ? 'eq' : 'diff') : ''; return `<tr><td>${lbl}</td><td class="${cls}">${esc(a) || '—'}</td><td class="${cls}">${esc(bb) || '—'}</td></tr>`; };
    return `<div class="card" style="${v.estado === 'REEMPLAZADO' ? 'opacity:.55' : ''}">
      <div class="row"><div class="grow"><span class="sem ${sem}"></span><b>${esc(v.cod)}</b> <span class="tag">${ROLES[v.rol] || v.rol}${v.unidad ? ' ' + esc(v.unidad) : ''}</span></div><span class="chip">${VEST[v.estado]}</span></div>
      <div class="muted" style="margin:4px 0 6px">${c ? esc(c.nombre) + ' · Grupo ' + esc(c.grupo) + ' · ' + esc(c.estadoLibros) + ' · Libros ' + money(c.libros) : 'Cuenta no encontrada'}</div>
      ${c && v.estado !== 'REEMPLAZADO' ? `<table class="cmp"><tr><th></th><th>Planta (placa / levantamiento)</th><th>Cortyvis</th></tr>
        ${fila('Serie', st.placa.serie || b.serie, c.serie)}${fila('Marca', st.placa.marca || b.marca, c.marca || c.fabricante)}${fila('Modelo', st.placa.modelo || b.modelo, c.modelo)}
        <tr><td>Ubicación</td><td>${esc(b.seccionNombre)}</td><td>${esc(c.ubicacion || c.cc)}</td></tr><tr><td>Compra</td><td>${esc(st.placa.anio || b.anio) || '—'}</td><td>${esc(c.fechaCompra || c.fInc) || '—'}</td></tr></table>` : ''}
      ${al.map(([k, t]) => `<div class="alert ${k === 'warn' ? '' : k}">${t}</div>`).join('')}
      ${v.motivo ? `<div class="muted" style="margin-top:6px">Motivo: ${esc(v.motivo)}${v.reemplaza ? ' · reemplaza a ' + esc(v.reemplaza) : ''}</div>` : ''}
      ${v.estado === 'REEMPLAZADO' ? '' : `<div class="row" style="margin-top:8px">
        ${v.estado === 'ORIGINAL' ? `<button class="btn small" data-a="vconf" data-i="${i}">Confirmar</button>` : ''}
        ${['ORIGINAL', 'CONFIRMADO', 'APROBADO'].includes(v.estado) ? `<button class="btn sec small" data-a="vcamb" data-i="${i}">Cambiar cuenta</button>` : ''}
        ${v.estado === 'PROPUESTO' ? `<button class="btn sec small" data-a="vquitar" data-i="${i}">Deshacer</button>` : ''}</div>`}
    </div>`;
  };
  const ph = (t, lbl, btn) => `<div class="ph"><div class="lbl">${lbl}</div>${fu[t] ? `<img src="${fu[t]}" data-zoom="${fu[t]}">` : ''}<button class="btn ${fu[t] ? 'sec' : ''} small block" data-a="foto" data-t="${t}">${fu[t] ? 'Repetir' : btn}</button></div>`;
  $('#app').innerHTML = `
  <div class="card"><div class="row"><div class="grow"><b style="font-size:17px">${esc(id)}</b>${st.nuevo ? '<span class="tag">Nueva</span>' : ''}</div>${chip(e)}</div>
    ${falt.length && st.existe !== false ? `<div class="alert">Falta: ${falt.map(esc).join(' · ')}</div>` : ''}
    ${b.thumb ? `<img class="photo" style="margin-top:10px" src="${b.thumb}" data-zoom="${b.thumb}" alt="Foto del levantamiento">` : ''}
    <div class="kv" style="margin-top:10px">
      <span>Código L´Arkad</span><span>${esc(b.codOrig) || '—'}</span><span>Descripción</span><span>${esc(b.desc) || '—'}</span>
      <span>Marca / modelo</span><span>${esc(b.marca)} ${esc(b.modelo)}</span><span>Año · País</span><span>${esc(b.anio) || '—'} · ${esc(b.pais) || '—'}</span>
      <span>Serie</span><span>${esc(b.serie) || '—'}</span><span>Estado (1.ª visita)</span><span>${esc(b.estado) || '—'}</span>
      ${b.obsLevantamiento ? `<span>Obs.</span><span>${esc(b.obsLevantamiento)}</span>` : ''}</div></div>

  ${st.nuevo ? `<div class="card"><h3>Datos de la máquina nueva</h3><div class="grid2">
    <div style="grid-column:1/3"><label class="f">Descripción</label><input type="text" data-b="desc" value="${esc(b.desc)}"></div>
    ${['marca', 'modelo', 'anio', 'serie', 'pais'].map(k => `<div><label class="f">${{ marca: 'Marca', modelo: 'Modelo', anio: 'Año', serie: 'Serie', pais: 'País' }[k]}</label><input type="text" data-b="${k}" value="${esc(b[k])}"></div>`).join('')}</div></div>` : ''}

  <div class="card"><h3>1. ¿La máquina está en planta?</h3>
    <div class="seg"><button data-a="existe" data-v="1" class="${st.existe === true ? 'on' : ''}">Sí, está aquí</button><button data-a="existe" data-v="0" class="${st.existe === false ? 'on' : ''}">No encontrada</button></div>
    ${st.existe === false ? '<div class="alert">No pegue su sticker: guárdelo para devolverlo. Detalle en Observaciones dónde se buscó.</div>' : ''}</div>

  <div class="${st.existe === false ? 'hide' : ''}">
  <div class="card"><h3>2. Placa</h3>
    <div class="ph-row">${ph('PLACA', 'Foto de la placa', 'Tomar foto de la placa')}</div>
    <div class="grid2">${inp('placa.serie', 'Serie leída en la placa', st.placa.serie)}${inp('placa.marca', 'Marca', st.placa.marca)}${inp('placa.modelo', 'Modelo', st.placa.modelo)}${inp('placa.anio', 'Año', st.placa.anio)}</div>
    <label class="row" style="margin-top:10px;font-size:14px"><input type="checkbox" data-c="placa.ilegible" ${st.placa.ilegible ? 'checked' : ''}> La placa no existe o es ilegible</label>
    ${st.placa.ilegible ? `<input type="text" data-k="placa.motivoIlegible" placeholder="Motivo (obligatorio)" value="${esc(st.placa.motivoIlegible)}" style="margin-top:6px">` : ''}</div>

  <div class="card"><h3>3. Foto del modelo</h3>
    ${st.nuevo ? `<div class="ph-row">${ph('MODELO', 'Foto del modelo', 'Tomar foto')}</div>` : `
    <div class="seg"><button data-a="modelo" data-v="ACTUAL" class="${st.modeloFoto === 'ACTUAL' ? 'on' : ''}">Usar la foto actual</button><button data-a="modelo" data-v="NUEVA" class="${st.modeloFoto === 'NUEVA' ? 'on' : ''}">Tomar una nueva</button></div>
    ${st.modeloFoto === 'NUEVA' ? `<div class="ph-row" style="margin-top:8px">${ph('MODELO', 'Foto nueva del modelo', 'Tomar foto')}</div>` : ''}`}</div>

  <div class="card"><h3>4. Estado y ubicación</h3>
    <div class="seg">${EST_FIS.map(x => `<button data-a="estf" data-v="${x}" class="${st.estadoFisico === x ? 'on' : ''}">${x[0] + x.slice(1).toLowerCase()}</button>`).join('')}</div>
    <label class="f">Ubicación</label>
    <div class="seg"><button data-a="ubic" data-v="1" class="${st.ubicacionOk === true ? 'on' : ''}">Correcta (${esc(b.seccion)})</button><button data-a="ubic" data-v="0" class="${st.ubicacionOk === false ? 'on' : ''}">Está en otro lugar</button></div>
    ${st.ubicacionOk === false ? `<input type="text" data-k="ubicacionNueva" placeholder="¿Dónde está?" value="${esc(st.ubicacionNueva)}" style="margin-top:6px">` : ''}</div>

  <div class="card"><h3>5. Cuenta contable</h3>
    ${vis.length ? '' : `<label class="row" style="font-size:14px"><input type="checkbox" data-c="sinCuenta" ${st.sinCuenta ? 'checked' : ''}> Confirmo que no tiene cuenta contable (sobrante)</label>`}
  </div>
  ${vis.map(v => tarjetaV(v, st.vinculos.indexOf(v))).join('')}
  <div class="row" style="margin-bottom:10px"><button class="btn sec grow" data-a="vadd">+ Agregar otra cuenta</button></div>
  <div class="card"><h3>6. Otros datos</h3>
    ${inp('moduloDe', 'Es módulo de (código de la máquina principal)', st.moduloDe)}
    ${inp('codNuevo', 'Código nuevo (solo si se rehace la codificación)', st.codNuevo)}
    <label class="row" style="margin-top:10px;font-size:14px"><input type="checkbox" data-c="tecnico.req" ${st.tecnico.req ? 'checked' : ''}> Requiere técnico de Cortyvis</label>
    ${st.tecnico.req ? `<input type="text" data-k="tecnico.motivo" placeholder="¿Qué no cuadra?" value="${esc(st.tecnico.motivo)}" style="margin-top:6px">` : ''}
  </div>
  <div class="card"><h3>7. Etiquetado</h3>
    ${st.nuevo ? `<div class="ph-row" style="margin-bottom:8px">${ph('PROVISIONAL', 'Rótulo provisional (cinta)', 'Foto del rótulo')}</div>` : ''}
    ${st.sticker.escaneado ? `<div class="alert info">Sticker escaneado y verificado ${esc(fmtFecha(st.sticker.ts))}.</div>` : `<p class="muted">${st.nuevo ? 'Cuando tenga el sticker impreso, escanéelo aquí antes de pegarlo.' : 'Escanee el sticker antes de pegarlo: la app comprueba que corresponde a esta máquina.'}</p>`}
    <button class="btn ${st.sticker.escaneado ? 'sec' : ''} block" data-a="escSticker">${st.sticker.escaneado ? 'Volver a escanear' : 'Escanear sticker'}</button>
    ${st.sticker.escaneado ? `<div class="ph-row" style="margin-top:8px">${ph('STICKER', 'Foto del sticker pegado (visible)', 'Tomar foto del sticker')}</div>` : ''}
  </div>
  </div>
  <div class="card"><h3>Observaciones</h3><textarea data-k="obs" placeholder="Notas de la verificación">${esc(st.obs)}</textarea></div>
  ${st.actualizado ? `<p class="muted" style="text-align:center">Última modificación: ${esc(fmtFecha(st.actualizado))} · ${esc(st.verificador)}</p>` : ''}`;
  ligarFicha(id);
}
function setPath(o, path, val) { const ks = path.split('.'); let x = o; while (ks.length > 1) x = x[ks.shift()]; x[ks[0]] = val; }
function ligarFicha(id) {
  const app = $('#app');
  app.querySelectorAll('[data-k]').forEach(el => el.onchange = async () => { const st = getSt(id); setPath(st, el.dataset.k, el.value.trim()); if (el.dataset.k.startsWith('placa.') && !st.existe) st.existe = true; await guardar(st, 'EDITAR', el.dataset.k + ' = ' + el.value.trim()); render(); });
  app.querySelectorAll('[data-b]').forEach(el => el.onchange = async () => { const st = getSt(id); st.base[el.dataset.b] = el.value.trim(); await guardar(st, 'EDITAR', 'datos.' + el.dataset.b); });
  app.querySelectorAll('[data-c]').forEach(el => el.onchange = async () => { const st = getSt(id); setPath(st, el.dataset.c, el.checked); await guardar(st, 'EDITAR', el.dataset.c + ' = ' + el.checked); render(); });
  app.querySelectorAll('[data-zoom]').forEach(el => el.onclick = () => modal(`<img src="${el.dataset.zoom}" style="width:100%;border-radius:10px"><button class="btn block" style="margin-top:10px" onclick="this.closest('.modal').remove()">Cerrar</button>`));
  app.querySelectorAll('[data-a]').forEach(el => el.onclick = () => accion(id, el.dataset.a, el.dataset));
}
async function accion(id, a, d) {
  const st = getSt(id); const b = base(id);
  if (a === 'existe') { st.existe = d.v === '1'; await guardar(st, 'EXISTE', String(st.existe)); return render(); }
  if (a === 'modelo') { if (d.v === 'NUEVA') { st.modeloFoto = 'NUEVA'; await guardar(st); return tomarFoto(id, 'MODELO'); } st.modeloFoto = 'ACTUAL'; st.existe = st.existe == null ? true : st.existe; await guardar(st, 'FOTO_MODELO', 'Usa la foto actual'); return render(); }
  if (a === 'estf') { st.estadoFisico = d.v; if (st.existe == null) st.existe = true; await guardar(st, 'ESTADO', d.v); return render(); }
  if (a === 'ubic') { st.ubicacionOk = d.v === '1'; await guardar(st, 'UBICACION', d.v === '1' ? 'Correcta' : 'Otro lugar'); return render(); }
  if (a === 'foto') { if (st.existe == null) { st.existe = true; await guardar(st); } return tomarFoto(id, d.t); }
  if (a === 'vconf') {
    const v = st.vinculos[+d.i]; const c = S.cuentas.get(v.cod);
    if (requiereAprob(c)) { const m = await pedirMotivo('Confirmar cuenta ' + v.cod, '<div class="alert">Esta cuenta requiere aprobación del coordinador (vendida, fuera del universo o sin Módulo).</div>'); if (!m) return; v.estado = 'PROPUESTO'; v.motivo = m; }
    else v.estado = 'CONFIRMADO';
    v.ts = now(); await guardar(st, 'CUENTA_' + v.estado, v.cod); return render();
  }
  if (a === 'vcamb') {
    if (!st.fotos.PLACA && !(st.placa.ilegible && st.placa.motivoIlegible)) { alerta('Primero la foto de la placa', 'Para cambiar la cuenta contable, tome antes la foto de la placa como evidencia.'); return; }
    const v = st.vinculos[+d.i];
    const c = await buscarCuenta('Nueva cuenta para ' + id, v.cod); if (!c) return;
    const m = await pedirMotivo('Cambiar ' + v.cod + ' → ' + c.cod); if (!m) return;
    v.estado = 'REEMPLAZADO'; v.ts = now();
    st.vinculos.push({ cod: c.cod, rol: v.rol, unidad: v.unidad, estado: 'PROPUESTO', origen: 'REASIGNADO', motivo: m, reemplaza: v.cod, ts: now() });
    await guardar(st, 'CUENTA_REASIGNADA', v.cod + ' → ' + c.cod + ' · ' + m); return render();
  }
  if (a === 'vquitar') {
    const v = st.vinculos[+d.i];
    if (v.origen === 'LEVANTAMIENTO') { v.estado = 'ORIGINAL'; v.motivo = ''; }
    else { st.vinculos.splice(+d.i, 1); if (v.reemplaza) { const o = st.vinculos.find(x => x.cod === v.reemplaza && x.estado === 'REEMPLAZADO'); if (o) o.estado = 'ORIGINAL'; } }
    await guardar(st, 'CUENTA_DESHACER', v.cod); return render();
  }
  if (a === 'vadd') {
    const rol = await elegirRol(); if (!rol) return;
    const c = await buscarCuenta('Agregar cuenta (' + ROLES[rol] + ')'); if (!c) return;
    const m = await pedirMotivo('Agregar ' + c.cod); if (!m) return;
    let unidad = '';
    if (rol === 'UNIDAD') { let n = 0; for (const s of S.st.values()) s.vinculos.forEach(v => { if (v.cod === c.cod && v.rol === 'UNIDAD' && v.estado !== 'RECHAZADO') n = Math.max(n, parseInt((v.unidad || 'U0').slice(1), 10)); }); unidad = 'U' + String(n + 1).padStart(2, '0'); }
    if (st.existe == null) st.existe = true;
    st.sinCuenta = false;
    st.vinculos.push({ cod: c.cod, rol, unidad, estado: 'PROPUESTO', origen: 'AGREGADO', motivo: m, reemplaza: '', ts: now() });
    await guardar(st, 'CUENTA_AGREGADA', c.cod + ' ' + rol + ' ' + unidad + ' · ' + m); return render();
  }
  if (a === 'escSticker') {
    escanear(async code => {
      if (code !== id) { alerta('Este sticker no es de esta máquina', `Escaneó <b>${esc(code)}</b>, pero la ficha abierta es <b>${esc(id)}</b>.<br><br>No lo pegue. Busque el sticker correcto.`); return; }
      const pu = st.fotos.PLACA ? await urlFoto(id + '_PLACA') : '';
      const ok = await confirmar('Comprobar antes de pegar', `${pu ? `<img src="${pu}" class="photo">` : '<div class="alert">No hay foto de la placa.</div>'}<div class="kv" style="margin-top:8px"><span>Serie registrada</span><span><b>${esc(st.placa.serie || b.serie || '—')}</b></span><span>Marca / modelo</span><span>${esc(st.placa.marca || b.marca)} ${esc(st.placa.modelo || b.modelo)}</span></div><p>¿La placa de la máquina coincide con estos datos?</p>`, 'Sí, coincide');
      if (!ok) return;
      st.sticker = { escaneado: true, ts: now() }; if (st.existe == null) st.existe = true;
      await guardar(st, 'STICKER_VERIFICADO', code); render(); toast('Pegue el sticker y tome la foto');
    });
  }
}
function elegirRol() {
  return new Promise(res => {
    const m = modal('<h2>¿Qué relación tiene la cuenta con esta máquina?</h2>' + Object.entries(ROLES).map(([k, t]) => `<button class="btn sec block" data-r="${k}" style="margin-bottom:8px">${t}</button>`).join('') + '<p class="muted">Unidad: varias máquinas comparten una misma cuenta. Mejora o accesorio: una máquina con varias cuentas. Módulo: parte de una máquina registrada aparte.</p><button class="btn sec block" data-n>Cancelar</button>');
    m.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { m.remove(); res(b.dataset.r); });
    m.querySelector('[data-n]').onclick = () => { m.remove(); res(null); };
  });
}
function buscarCuenta(titulo, excluir) {
  return new Promise(res => {
    let otros = false;
    const m = modal(`<h2>${esc(titulo)}</h2><input type="search" id="bq" placeholder="Código, nombre, marca o serie"><label class="row" style="font-size:14px;margin:8px 0"><input type="checkbox" id="bo"> Incluir otros grupos (fuera de 0003 y 0004)</label><div id="br" class="list"></div><button class="btn sec block" data-n style="margin-top:10px">Cancelar</button>`);
    const vinc = vinculadas();
    const pintar = () => {
      const q = norm(m.querySelector('#bq').value);
      let l = [...S.cuentas.values()].filter(c => c.cod !== excluir && (otros || c.grupo === '0003' || c.grupo === '0004'));
      if (q) l = l.filter(c => [c.cod, c.nombre, c.marca, c.serie, c.modelo, c.ubicacion].some(x => norm(x).includes(q)));
      m.querySelector('#br').innerHTML = l.slice(0, 60).map(c => { const v = vinc.get(c.cod);
        return `<div class="it" data-c="${esc(c.cod)}"><div class="grow"><div><b>${esc(c.cod)}</b> <span class="tag">${esc(c.estadoLibros)}</span>${c.grupo !== '0003' && c.grupo !== '0004' ? '<span class="tag">Grupo ' + esc(c.grupo) + '</span>' : ''}</div><div>${esc(c.nombre)}</div><div class="muted">${esc(c.marca)} ${c.serie ? '· S/N ' + esc(c.serie) : ''} · ${esc(c.ubicacion || c.cc)}${v ? ' · vinculada a ' + [...v].map(esc).join(', ') : ''}</div></div></div>`; }).join('') + (l.length > 60 ? `<p class="muted">${l.length - 60} resultados más: afine la búsqueda.</p>` : '') || '<p class="muted">Sin resultados</p>';
      m.querySelectorAll('[data-c]').forEach(e => e.onclick = () => { m.remove(); res(S.cuentas.get(e.dataset.c)); });
    };
    m.querySelector('#bq').oninput = pintar; m.querySelector('#bo').onchange = e => { otros = e.target.checked; pintar(); };
    m.querySelector('[data-n]').onclick = () => { m.remove(); res(null); };
    pintar();
  });
}

/* ----- Escáner QR ----- */
let scanStream = null;
function escanear(cb) {
  const ov = document.createElement('div'); ov.id = 'scan';
  ov.innerHTML = '<video playsinline muted></video><div class="ov"></div><div class="bt"><button class="btn sec grow" data-man>Escribir código</button><button class="btn warn grow" data-x>Cerrar</button></div>';
  document.body.appendChild(ov);
  const video = ov.querySelector('video'), cv = document.createElement('canvas'), ctx = cv.getContext('2d', { willReadFrequently: true });
  let vivo = true, last = 0;
  const cerrar = () => { vivo = false; if (scanStream) scanStream.getTracks().forEach(t => t.stop()); scanStream = null; ov.remove(); };
  const fin = code => { cerrar(); cb(String(code).trim().toUpperCase()); };
  ov.querySelector('[data-x]').onclick = cerrar;
  ov.querySelector('[data-man]').onclick = () => {
    const m = modal('<h2>Escribir código</h2><input type="text" id="mc" placeholder="P1-S01-0001" autocapitalize="characters"><button class="btn block" style="margin-top:10px" data-s>Aceptar</button>');
    m.style.zIndex = 70; m.querySelector('[data-s]').onclick = () => { const v = m.querySelector('#mc').value.trim(); m.remove(); if (v) fin(v); };
  };
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(s => {
    scanStream = s; video.srcObject = s; video.play();
    const loop = t => {
      if (!vivo) return;
      if (t - last > 180 && video.readyState >= 2) {
        last = t; const w = video.videoWidth, h = video.videoHeight; const k = Math.min(1, 720 / Math.max(w, h));
        cv.width = Math.round(w * k); cv.height = Math.round(h * k); ctx.drawImage(video, 0, 0, cv.width, cv.height);
        const img = ctx.getImageData(0, 0, cv.width, cv.height); const r = window.jsQR ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
        if (r && r.data) { if (navigator.vibrate) navigator.vibrate(80); fin(r.data); return; }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }).catch(e => { toast('No se pudo abrir la cámara: ' + e.message); });
}
function abrirPorQR() {
  escanear(code => {
    if (base(code)) { const b = base(code); if (b.planta !== S.set.planta) { alerta('Sticker de otra planta', esc(code) + ' pertenece a la Planta ' + esc(b.planta.slice(1)) + '.'); return; } go('ficha', { id: code }); return; }
    const pl = code.slice(0, 2);
    if (/^P\d-S\d\d-\d{4}$/.test(code) && pl !== S.set.planta) { alerta('Sticker de otra planta', esc(code) + ' corresponde a la Planta ' + esc(pl.slice(1)) + '. Cambie de planta en Ajustes si corresponde.'); return; }
    alerta('Código no encontrado', 'El código <b>' + esc(code) + '</b> no está en el paquete de esta planta.');
  });
}

/* ----- Buscar en contabilidad ----- */
function vContabilidad() {
  setHeader('Buscar en contabilidad');
  const f = S.contab, vinc = vinculadas();
  const ubics = [...new Set([...S.cuentas.values()].map(c => c.ubicacion || c.cc).filter(Boolean))].sort();
  let l = [...S.cuentas.values()].filter(c => !vinc.has(c.cod) && (f.otros || c.grupo === '0003' || c.grupo === '0004') && (f.vendidas || c.estadoLibros !== 'VENDIDO'));
  if (f.ubic) l = l.filter(c => (c.ubicacion || c.cc) === f.ubic);
  const q = norm(f.q); if (q) l = l.filter(c => [c.cod, c.nombre, c.marca, c.serie, c.modelo].some(x => norm(x).includes(q)));
  l.sort((a, b) => (b.libros || 0) - (a.libros || 0));
  $('#app').innerHTML = `
  <div class="card"><p class="muted" style="margin-top:0">Cuentas contables que todavía no tienen máquina vinculada. Si encuentra una en planta, regístrela como máquina nueva.</p>
    <input type="search" id="q" placeholder="Código, nombre, marca o serie" value="${esc(f.q)}">
    <label class="f">Ubicación / centro de costo</label><select id="u"><option value="">Todas</option>${ubics.map(u => `<option ${u === f.ubic ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
    <label class="row" style="font-size:14px;margin-top:8px"><input type="checkbox" id="o" ${f.otros ? 'checked' : ''}> Incluir otros grupos</label>
    <label class="row" style="font-size:14px;margin-top:4px"><input type="checkbox" id="v" ${f.vendidas ? 'checked' : ''}> Incluir vendidas según libros</label></div>
  <p class="muted">${l.length} cuentas sin máquina vinculada (ordenadas por valor en libros).</p>
  <div class="card list" id="lst">${l.slice(0, 80).map(c => `<div class="it" data-c="${esc(c.cod)}"><div class="grow"><div><b>${esc(c.cod)}</b> <span class="tag">${esc(c.estadoLibros)}</span> <span class="tag">${money(c.libros)}</span></div><div>${esc(c.nombre)}</div><div class="muted">${esc(c.marca)} ${c.serie ? '· S/N ' + esc(c.serie) : ''} · ${esc(c.ubicacion || c.cc)}${c.cantidad > 1 ? ' · ' + c.cantidad + ' unidades en libros' : ''}</div></div></div>`).join('') || '<p class="muted">Nada que mostrar.</p>'}</div>`;
  const up = () => { S.contab.q = $('#q').value; S.contab.ubic = $('#u').value; S.contab.otros = $('#o').checked; S.contab.vendidas = $('#v').checked; render(); };
  $('#q').onchange = up; $('#u').onchange = up; $('#o').onchange = up; $('#v').onchange = up;
  document.querySelectorAll('#lst [data-c]').forEach(e => e.onclick = () => {
    const c = S.cuentas.get(e.dataset.c); const secs = secciones();
    const m = modal(`<h2>${esc(c.cod)}</h2><div class="kv"><span>Nombre</span><span>${esc(c.nombre)}</span><span>Grupo</span><span>${esc(c.grupo)} ${esc(c.grupoNombre)}</span><span>Marca / modelo</span><span>${esc(c.marca)} ${esc(c.modelo)}</span><span>Serie</span><span>${esc(c.serie) || '—'}</span><span>Ubicación</span><span>${esc(c.ubicacion || c.cc)}</span><span>Compra</span><span>${esc(c.fechaCompra || c.fInc)}</span><span>Estado libros</span><span>${esc(c.estadoLibros)}</span><span>Costo / libros</span><span>${money(c.costo)} / ${money(c.libros)}</span></div>
      <label class="f">Registrar como máquina nueva en la sección</label><select id="s">${secs.map(s => `<option value="${s.id}">${s.id} · ${esc(s.nombre)}</option>`).join('')}</select>
      <div class="row" style="margin-top:12px"><button class="btn sec grow" data-n>Cerrar</button><button class="btn grow" data-s>Registrar</button></div>`);
    m.querySelector('[data-n]').onclick = () => m.remove();
    m.querySelector('[data-s]').onclick = () => { const s = secs.find(x => x.id === m.querySelector('#s').value); m.remove(); nuevaMaquina(s.id, s.nombre, c); };
  });
}

/* ----- Coordinador ----- */
async function vCoordinador() {
  setHeader('Coordinador');
  if (Date.now() > S.coordHasta) {
    const nuevo = !S.set.pin;
    $('#app').innerHTML = `<div class="card"><h3>${nuevo ? 'Crear PIN de coordinador' : 'Ingresar PIN'}</h3><p class="muted">${nuevo ? 'Este PIN protege las aprobaciones en este teléfono. Lo ingresa solo el coordinador.' : 'Solo el coordinador aprueba cambios y cierra secciones.'}</p>
      <input type="password" id="p1" inputmode="numeric" placeholder="PIN (4 a 6 dígitos)">${nuevo ? '<input type="password" id="p2" inputmode="numeric" placeholder="Repita el PIN" style="margin-top:8px">' : ''}
      <button class="btn block" id="bp" style="margin-top:10px">${nuevo ? 'Crear PIN' : 'Entrar'}</button></div>`;
    $('#bp').onclick = async () => {
      const p1 = $('#p1').value.trim();
      if (nuevo) { if (!/^\d{4,6}$/.test(p1) || p1 !== $('#p2').value.trim()) { toast('Los PIN no coinciden o no tienen 4 a 6 dígitos'); return; } S.set.pin = p1; await saveSet(); }
      else if (p1 !== S.set.pin) { toast('PIN incorrecto'); return; }
      S.coordHasta = Date.now() + 20 * 60000; render();
    };
    return;
  }
  const props = [], tecn = [];
  for (const st of S.st.values()) { if (st.planta !== S.set.planta) continue; st.vinculos.forEach((v, i) => { if (v.estado === 'PROPUESTO') props.push({ st, v, i }); }); if (st.tecnico.req) tecn.push(st); }
  const secs = secciones(), cierres = S.set.secciones || {};
  $('#app').innerHTML = `
  <div class="card"><div class="row"><h3 class="grow" style="margin:0">Aprobaciones pendientes (${props.length})</h3><button class="btn sec small" id="bLock">Salir</button></div>
    ${props.map(({ st, v, i }) => { const c = S.cuentas.get(v.cod); return `<div style="border-top:1px solid var(--lin);padding:9px 0">
      <div><b data-go="${esc(st.id)}" style="text-decoration:underline">${esc(st.id)}</b> → <b>${esc(v.cod)}</b> <span class="tag">${ROLES[v.rol]}${v.unidad ? ' ' + esc(v.unidad) : ''}</span> <span class="tag">${esc(v.origen)}</span></div>
      <div class="muted">${c ? esc(c.nombre) + ' · ' + esc(c.estadoLibros) + ' · grupo ' + esc(c.grupo) : 'Cuenta no encontrada'}${v.reemplaza ? ' · reemplaza a ' + esc(v.reemplaza) : ''}</div>
      <div class="muted">Motivo: ${esc(v.motivo)} · ${esc(st.verificador)}</div>
      <div class="row" style="margin-top:6px"><button class="btn small" data-ap="${esc(st.id)}|${i}">Aprobar</button><button class="btn sec small" data-re="${esc(st.id)}|${i}">Rechazar</button></div></div>`; }).join('') || '<p class="muted">No hay cambios por aprobar.</p>'}</div>
  <div class="card"><h3>Requieren técnico (${tecn.length})</h3>${tecn.map(st => `<div class="it" data-go="${esc(st.id)}"><div class="grow"><b>${esc(st.id)}</b><div class="muted">${esc(st.tecnico.motivo)}</div></div></div>`).join('') || '<p class="muted">Ninguna.</p>'}</div>
  <div class="card"><h3>Cierre por sección</h3>${secs.map(s => { const k = conteo(s.maq), ci = cierres[S.set.planta + '-' + s.id] || {};
      const pendProp = s.maq.some(b => { const st = S.st.get(b.id); return st && (st.vinculos.some(v => v.estado === 'PROPUESTO') || st.tecnico.req); });
      const puedeP = !k.PENDIENTE && !k.EN_PROCESO && !pendProp, puedeF = puedeP && !k.CORROBORADA && !k.ETIQUETADA_PEND;
      return `<div style="border-top:1px solid var(--lin);padding:9px 0"><div><b>${s.id}</b> ${esc(s.nombre)}</div>
      <div class="muted">${s.maq.length} máq. · ${k.CERRADA} cerradas · ${k.CORROBORADA} sin sticker · ${k.ETIQUETADA_PEND} pend. aprobación · ${k.NO_ENCONTRADA} no encontradas · ${k.PENDIENTE + k.EN_PROCESO} por revisar</div>
      <div class="row" style="margin-top:6px">${ci.parcial ? `<span class="tag">Parcial ${esc(fmtFecha(ci.parcial))}</span>` : `<button class="btn small" data-cp="${s.id}" ${puedeP ? '' : 'disabled'}>Cierre parcial</button>`}
        ${ci.final ? `<span class="tag">Final ${esc(fmtFecha(ci.final))}</span>` : `<button class="btn small" data-cf="${s.id}" ${puedeF ? '' : 'disabled'}>Cierre final</button>`}</div></div>`; }).join('')}
    <p class="muted">Cierre parcial: todo revisado y sin aprobaciones pendientes (pueden faltar stickers de máquinas nuevas). Cierre final: todas cerradas o no encontradas.</p></div>`;
  $('#bLock').onclick = () => { S.coordHasta = 0; render(); };
  document.querySelectorAll('[data-go]').forEach(e => e.onclick = () => go('ficha', { id: e.dataset.go }));
  const decidir = async (key, ok) => {
    const [id, i] = key.split('|'); const st = getSt(id); const v = st.vinculos[+i];
    if (ok) { v.estado = 'APROBADO'; } else { v.estado = 'RECHAZADO'; if (v.reemplaza) { const o = st.vinculos.find(x => x.cod === v.reemplaza && x.estado === 'REEMPLAZADO'); if (o) o.estado = 'ORIGINAL'; } }
    v.aprobadoPor = 'COORDINADOR'; v.tsAprob = now();
    const ver = st.verificador; await guardar(st, ok ? 'APROBADO' : 'RECHAZADO', v.cod); st.verificador = ver; await DB.put('m', st); render();
  };
  document.querySelectorAll('[data-ap]').forEach(e => e.onclick = () => decidir(e.dataset.ap, true));
  document.querySelectorAll('[data-re]').forEach(e => e.onclick = () => decidir(e.dataset.re, false));
  const cerrar = async (sec, tipo) => {
    if (!await confirmar('Cierre ' + tipo + ' de ' + sec, '¿Confirma el cierre ' + tipo + ' de la sección ' + esc(sec) + '?', 'Cerrar')) return;
    S.set.secciones = S.set.secciones || {}; const k = S.set.planta + '-' + sec; S.set.secciones[k] = S.set.secciones[k] || {};
    S.set.secciones[k][tipo === 'parcial' ? 'parcial' : 'final'] = now(); await saveSet(); await log(sec, 'CIERRE_' + tipo.toUpperCase(), ''); render();
  };
  document.querySelectorAll('[data-cp]').forEach(e => e.onclick = () => cerrar(e.dataset.cp, 'parcial'));
  document.querySelectorAll('[data-cf]').forEach(e => e.onclick = () => cerrar(e.dataset.cf, 'final'));
}

/* ----- Exportar / restaurar ----- */
async function vExportar() {
  setHeader('Exportar');
  const keys = (await DB.keys('fotos')).filter(k => String(k).startsWith(S.set.planta + '-'));
  let nuevas = 0; for (const k of keys) { const r = await DB.get('fotos', k); if (r && !r.exportado) nuevas++; }
  const c = conteo(maquinasPlanta());
  $('#app').innerHTML = `
  <div class="card"><h3>Exportar el avance de la Planta ${esc(S.set.planta.slice(1))}</h3>
    <p class="muted">Genera un ZIP con el Excel del checklist, el respaldo de datos y las fotos. Expórtelo <b>al cierre de cada visita</b> y páselo al computador con Wi-Fi o cable.</p>
    <div class="kv"><span>Revisadas</span><span>${c.CERRADA + c.CORROBORADA + c.ETIQUETADA_PEND + c.NO_ENCONTRADA} de ${maquinasPlanta().length}</span><span>Fotos en el teléfono</span><span>${keys.length} (${nuevas} sin exportar)</span><span>Última exportación</span><span>${esc(fmtFecha(S.set.ultimaExport)) || '—'}</span></div>
    <label class="row" style="font-size:14px;margin-top:10px"><input type="checkbox" id="todas"> Incluir todas las fotos (no solo las nuevas)</label>
    <button class="btn block" id="bExp" style="margin-top:10px">Generar exportación</button>
    <div id="out" style="margin-top:10px"></div></div>`;
  $('#bExp').onclick = async () => {
    $('#bExp').disabled = true; $('#out').innerHTML = '<p class="muted">Generando… no cierre la app.</p>';
    try { const { blob, nombre, n } = await exportar($('#todas').checked); mostrarDescarga(blob, nombre, n); }
    catch (e) { $('#out').innerHTML = '<div class="alert bad">Error: ' + esc(e.message) + '</div>'; }
    $('#bExp').disabled = false;
  };
}
function filasExport() {
  const vinc = vinculadas(); const maq = [], vins = [], tec = [], stk = [];
  for (const b of maquinasPlanta()) {
    const st = S.st.get(b.id); const e = estadoDe(st); const s = st || defState(b);
    maq.push({ Codigo: b.id, Planta: b.planta, Seccion: b.seccion, NombreSeccion: b.seccionNombre, Nueva: s.nuevo ? 'SI' : '', Estado: ESTADOS[e], Existe: s.existe === true ? 'SI' : s.existe === false ? 'NO' : '',
      CodigoLArkadOriginal: b.codOrig, CodigoNuevo: s.codNuevo, Descripcion: b.desc, Marca_Lev: b.marca, Modelo_Lev: b.modelo, Anio_Lev: b.anio, Serie_Lev: b.serie, Pais_Lev: b.pais, Estado_Lev: b.estado,
      Serie_Placa: s.placa.serie, Marca_Placa: s.placa.marca, Modelo_Placa: s.placa.modelo, Anio_Placa: s.placa.anio, PlacaIlegible: s.placa.ilegible ? 'SI: ' + s.placa.motivoIlegible : '',
      EstadoFisico: s.estadoFisico, Ubicacion: s.ubicacionOk === true ? 'CORRECTA' : s.ubicacionOk === false ? 'OTRA: ' + s.ubicacionNueva : '', ModuloDe: s.moduloDe, SinCuenta: s.sinCuenta ? 'SI' : '',
      CuentasActivas: activos(s).map(v => v.cod + ' (' + VEST[v.estado] + ')').join('; '), RequiereTecnico: s.tecnico.req ? 'SI' : '', MotivoTecnico: s.tecnico.motivo,
      Foto_Placa: s.fotos.PLACA ? b.id + '_PLACA.jpg' : '', Foto_Modelo: s.fotos.MODELO ? b.id + '_MODELO.jpg' : (s.modeloFoto === 'ACTUAL' ? 'FOTO LEVANTAMIENTO ' + b.codOrig : ''),
      Foto_Sticker: s.fotos.STICKER ? b.id + '_STICKER.jpg' : '', Foto_Provisional: s.fotos.PROVISIONAL ? b.id + '_PROVISIONAL.jpg' : '', StickerVerificado: s.sticker.escaneado ? s.sticker.ts : '',
      Observaciones: s.obs, Verificador: s.verificador, Actualizado: s.actualizado });
    s.vinculos.forEach(v => { const c = S.cuentas.get(v.cod) || {};
      vins.push({ Codigo: b.id, CuentaContable: v.cod, Rol: ROLES[v.rol] || v.rol, Unidad: v.unidad, EstadoVinculo: VEST[v.estado], Origen: v.origen, Reemplaza: v.reemplaza, Motivo: v.motivo,
        NombreCuenta: c.nombre || '', Grupo: c.grupo || '', EstadoLibros: c.estadoLibros || '', Costo: c.costo || '', ValorLibros: c.libros || '', CantidadLibros: c.cantidad || '',
        Semaforo: semaforo(s, b, S.cuentas.get(v.cod)).toUpperCase(), Alertas: (v.estado === 'REEMPLAZADO' ? [] : alertasCuenta(S.cuentas.get(v.cod), s, v, vinc)).map(x => x[1].replace(/<[^>]+>/g, '')).join(' | '), Fecha: v.ts, Aprobacion: v.tsAprob || '' }); });
    if (s.tecnico.req) tec.push({ Codigo: b.id, Seccion: b.seccion, Descripcion: b.desc, Motivo: s.tecnico.motivo, Verificador: s.verificador });
    if (s.nuevo && !s.sticker.escaneado && s.existe !== false) stk.push({ Codigo: b.id, NombreSeccion: b.seccionNombre, Descripcion: b.desc });
  }
  return { maq, vins, tec, stk };
}
async function exportar(todas) {
  const zip = new JSZip(); const t = new Date(); const pad = n => String(n).padStart(2, '0');
  const stamp = t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '_' + pad(t.getHours()) + pad(t.getMinutes());
  const ver = (S.set.verificador || 'VERIF').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 20);
  const nombre = `Cortyvis_${S.set.planta}_${ver}_${stamp}`;
  const { maq, vins, tec, stk } = filasExport();
  const logs = (await DB.all('log')).filter(l => l.planta === S.set.planta);
  const secs = Object.entries(S.set.secciones || {}).filter(([k]) => k.startsWith(S.set.planta)).map(([k, v]) => ({ Seccion: k, CierreParcial: v.parcial || '', CierreFinal: v.final || '' }));
  const wb = XLSX.utils.book_new();
  const hoja = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ '(sin datos)': '' }]), name);
  hoja(maq, 'Maquinas'); hoja(vins, 'Vinculos'); hoja(logs.map(l => ({ Fecha: l.ts, Verificador: l.verificador, Codigo: l.id, Accion: l.accion, Detalle: l.detalle })), 'Bitacora');
  hoja(tec, 'PendientesTecnico'); hoja(stk, 'StickersPorImprimir'); hoja(secs, 'Secciones');
  zip.file(nombre + '.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
  const estados = [...S.st.values()].filter(s => s.planta === S.set.planta);
  zip.file('estado.json', JSON.stringify({ meta: { tipo: 'CORTYVIS-AVANCE', version: 1, app: APP_VER, planta: S.set.planta, verificador: S.set.verificador, generado: now() }, estados, log: logs, secciones: S.set.secciones || {} }));
  const keys = (await DB.keys('fotos')).filter(k => String(k).startsWith(S.set.planta + '-'));
  const incl = []; const carpeta = zip.folder('fotos');
  for (const k of keys) { const r = await DB.get('fotos', k); if (r && (todas || !r.exportado)) { carpeta.file(k + '.jpg', r.blob); incl.push(k); } }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  for (const k of incl) { const r = await DB.get('fotos', k); r.exportado = true; await DB.put('fotos', r, k); }
  S.set.ultimaExport = now(); await saveSet(); await log('', 'EXPORTAR', nombre + ' · ' + incl.length + ' fotos');
  return { blob, nombre: nombre + '.zip', n: incl.length };
}
function mostrarDescarga(blob, nombre, n) {
  const file = new File([blob], nombre, { type: 'application/zip' });
  const url = URL.createObjectURL(blob); const mb = (blob.size / 1048576).toFixed(1);
  const puedeCompartir = navigator.canShare && navigator.canShare({ files: [file] });
  $('#out').innerHTML = `<div class="alert info">Listo: ${esc(nombre)} · ${mb} MB · ${n} fotos.</div>
    ${puedeCompartir ? '<button class="btn block" id="bSh" style="margin-top:8px">Guardar o compartir (Archivos, OneDrive, Drive)</button>' : ''}
    <a class="btn ${puedeCompartir ? 'sec' : ''} block" id="bDl" href="${url}" download="${esc(nombre)}" style="margin-top:8px;text-decoration:none">Descargar</a>
    <p class="muted">Use Wi-Fi o cable. No lo envíe por WhatsApp: reduce la calidad de las fotos.</p>`;
  if (puedeCompartir) $('#bSh').onclick = () => navigator.share({ files: [file], title: nombre }).catch(() => {});
}
async function restaurar() {
  const f = await elegirArchivo('.zip,application/zip'); if (!f) return;
  try {
    toast('Leyendo respaldo…');
    const zip = await JSZip.loadAsync(f); const ej = zip.file('estado.json'); if (!ej) throw new Error('El ZIP no contiene estado.json');
    const data = JSON.parse(await ej.async('string')); if (!data.meta || data.meta.tipo !== 'CORTYVIS-AVANCE') throw new Error('No es una exportación de la app.');
    let n = 0;
    for (const st of data.estados) { const cur = S.st.get(st.id); if (!cur || (st.actualizado || '') > (cur.actualizado || '')) { S.st.set(st.id, st); await DB.put('m', st); n++; } }
    const fotos = Object.keys(zip.files).filter(k => k.startsWith('fotos/') && k.endsWith('.jpg'));
    for (const k of fotos) { const key = k.slice(6, -4); const blob = await zip.file(k).async('blob'); await DB.put('fotos', { blob: new Blob([blob], { type: 'image/jpeg' }), ts: now(), exportado: true }, key); }
    S.set.secciones = Object.assign({}, data.secciones || {}, S.set.secciones || {}); await saveSet();
    await log('', 'RESTAURAR', f.name + ' · ' + n + ' máquinas · ' + fotos.length + ' fotos');
    alerta('Respaldo restaurado', n + ' máquinas actualizadas y ' + fotos.length + ' fotos recuperadas.'); render();
  } catch (e) { alerta('No se pudo restaurar', esc(e.message)); }
}

/* ---------------- Arranque ---------------- */
async function init() {
  try {
    await DB.open();
    S.set = (await DB.get('kv', 'settings')) || {};
    if (S.set.planta) { S.pkg = await DB.get('kv', 'pkg_' + S.set.planta); indexar(); }
    (await DB.all('m')).forEach(st => S.st.set(st.id, st));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { $('#app').innerHTML = '<div class="alert bad">No se pudo abrir el almacenamiento del teléfono: ' + esc(e.message) + '</div>'; return; }
  $('#hBack').onclick = back;
  $('#fab').onclick = abrirPorQR;
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => tabRoot(b.dataset.t));
  S.stack = [{ name: S.pkg && S.set.verificador ? 'secciones' : 'inicio', params: {} }];
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
