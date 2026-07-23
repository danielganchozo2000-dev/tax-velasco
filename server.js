const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, delay } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const axios = require('axios');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
// Render necesita CORS y JSON grande
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info_baileys';
const CREDS_PATH = path.join(AUTH_FOLDER, 'creds.json');

// URL BUENA - Forzamos si Render trae la vieja AKfycbx09J
let GOOGLE_SHEET_URL = (process.env.GOOGLE_SHEET_URL && !process.env.GOOGLE_SHEET_URL.includes('AKfycbx09J') && !process.env.GOOGLE_SHEET_URL.includes('onrender.com')
    ? process.env.GOOGLE_SHEET_URL
    : 'https://script.google.com/macros/s/AKfycbx7BQTSU3yIwItZnKfKepL-IgWzmDnPHBxI4iVCJU9Yn0W4WX-zmugptwZBMoJSW4NH/exec');
let sheetToNotify = null;

let qrCodeData = null;
let isConnected = false;
let sockInstance = null;
let isStarting = false;

console.log('=================================================');
console.log('TAX VELASCO V6.0 - PRODUCCION RENDER FINAL');
console.log('GOOGLE_SHEET_URL:', GOOGLE_SHEET_URL.substring(0, 80));
console.log('=================================================');

// Crear carpeta auth si no existe (Render la borra en cada deploy limpio)
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    console.log('Carpeta auth creada');
}

// ===== UTILIDADES =====
function formatNumber(numero) {
    if (!numero) return null;
    let num = ('' + numero).replace(/[^0-9]/g, '');
    if (!num) return null;
    // Si no tiene codigo pais, asumir Ecuador 593? dejamos como viene, Baileys lo resuelve
    if (!num.includes('@')) {
        // Si empieza con 0, quitarlo
        if (num.startsWith('0')) num = num.substring(1);
        // Si es de Ecuador y tiene 9 digitos y empieza con 9, agregar 593
        if (num.length === 9 && num.startsWith('9')) num = '593' + num;
        // Si ya tiene 12-13 digitos, dejarlo
        return num + '@s.whatsapp.net';
    }
    return num;
}

async function restaurarSesionDesdeString(sessionStr) {
    if (!sessionStr || sessionStr.length < 20) return false;
    try {
        // Si es JSON de creds
        if (sessionStr.trim().startsWith('{')) {
            if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
            fs.writeFileSync(CREDS_PATH, sessionStr, 'utf8');
            console.log('Sesion restaurada desde token_qr JSON');
            return true;
        }
        // Si es base64 de JSON
        try {
            const decoded = Buffer.from(sessionStr, 'base64').toString('utf8');
            if (decoded.trim().startsWith('{')) {
                fs.writeFileSync(CREDS_PATH, decoded, 'utf8');
                console.log('Sesion restaurada desde base64');
                return true;
            }
        } catch {}
    } catch (e) {
        console.log('Error restaurando sesion', e.message);
    }
    return false;
}

// ===== REPORTES A GOOGLE SHEET =====
async function reportarAHoja(qr, session = '', numero = '') {
    const targetUrl = sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl || targetUrl.includes('onrender.com')) return;
    if (targetUrl.includes('AKfycbx09J') || targetUrl.includes('AKfycbz8')) {
        console.log('URL vieja detectada, ignorando reporte');
        return;
    }
    try {
        console.log('Reportando QR/CONECTADO a hoja...');
        await axios.post(targetUrl, { op: 'qr', qr: qr, session: session, numero: numero }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        console.log('Reporte QR OK');
    } catch (e) {
        console.log('Error reporte QR: ' + (e.response?.status || e.message));
    }
}

async function reportarGruposAHoja(mensajesGrupos, overrideUrl = null) {
    const targetUrl = overrideUrl || sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl || targetUrl.includes('onrender.com')) return;
    try {
        console.log(`Reportando ${mensajesGrupos.length} grupos a hoja`);
        await axios.post(targetUrl, { op: 'grupos', mensajes: mensajesGrupos }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
        console.log('Grupos reportados OK');
    } catch (e) {
        console.log('Error reporte grupos: ' + e.message);
    }
}

async function reportarResultadoMensajes(resultados, overrideUrl = null) {
    const targetUrl = overrideUrl || sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl || targetUrl.includes('onrender.com')) return;
    try {
        console.log(`Reportando resultado ${resultados.length} mensajes`);
        await axios.post(targetUrl, { op: 'resultado', mensajes: resultados }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
        console.log('Resultado mensajes OK');
    } catch (e) {
        console.log('Error reporte resultado: ' + e.message);
    }
}

async function reportarValidacion(resultados, overrideUrl = null) {
    const targetUrl = overrideUrl || sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl || targetUrl.includes('onrender.com')) return;
    try {
        await axios.post(targetUrl, { op: 'save_validanumero', validar_numero: resultados }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
        console.log('Validacion reportada OK');
    } catch (e) {
        console.log('Error validacion: ' + e.message);
    }
}

// ===== BAILEYS LOGICA =====
async function obtenerGrupos() {
    if (!isConnected || !sockInstance) throw new Error('Bot no conectado - escanea QR en /qr');
    const groupsMap = await sockInstance.groupFetchAllParticipating();
    return Object.values(groupsMap).map(g => ({
        id: g.id,
        nombre: g.subject,
        subject: g.subject,
        participantes: g.participants ? g.participants.length : 0
    }));
}

async function enviarMensajes(dataArray, appScriptUrl) {
    if (!isConnected || !sockInstance) throw new Error('Bot no conectado');
    const resultados = [];
    const targetUrl = appScriptUrl || sheetToNotify || GOOGLE_SHEET_URL;

    for (let i = 0; i < dataArray.length; i++) {
        const item = dataArray[i];
        const posicion = item.posicion || i.toString();
        let estado = 'Enviado';
        try {
            const jid = formatNumber(item.numero);
            if (!jid) throw new Error('Numero invalido');

            // Validacion opcional
            if (item.aplicavalidacion === 'SI') {
                try {
                    const check = await sockInstance.onWhatsApp(jid);
                    if (!check || check.length === 0 || !check[0]?.exists) {
                        throw new Error('Numero no existe en WhatsApp');
                    }
                } catch (e) {
                    throw new Error('No es WhatsApp: ' + e.message);
                }
            }

            let mensaje = item.mensaje || '';
            let url = item.url || '';

            if (url && url.startsWith('http')) {
                // Detectar tipo por extension
                const lowerUrl = url.toLowerCase();
                if (lowerUrl.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
                    await sockInstance.sendMessage(jid, { image: { url: url }, caption: mensaje });
                } else if (lowerUrl.match(/\.(mp4|mov|avi)$/)) {
                    await sockInstance.sendMessage(jid, { video: { url: url }, caption: mensaje });
                } else if (lowerUrl.match(/\.(pdf|doc|docx|xls|xlsx)$/)) {
                    await sockInstance.sendMessage(jid, { document: { url: url }, mimetype: 'application/pdf', fileName: 'documento.pdf', caption: mensaje });
                } else {
                    // URL generica, enviar como texto + url
                    await sockInstance.sendMessage(jid, { text: (mensaje ? mensaje + '\n' + url : url) });
                }
            } else if (mensaje) {
                await sockInstance.sendMessage(jid, { text: mensaje });
            } else {
                throw new Error('Sin mensaje ni URL');
            }

            console.log(`Mensaje enviado a ${item.numero} pos ${posicion}`);
        } catch (e) {
            console.log(`Error enviando a ${item.numero}: ${e.message}`);
            estado = 'Error: ' + e.message.substring(0, 100);
        }
        resultados.push({ posicion: posicion, estado: estado });

        // Intervalo random
        let intervalo = 2000;
        if (item.intervalo_mensaje) {
            const parsed = parseInt(item.intervalo_mensaje);
            if (!isNaN(parsed) && parsed > 0) intervalo = parsed * 1000;
        } else {
            intervalo = 2000 + Math.random() * 3000; // 2-5 seg aleatorio para no ser bloqueado
        }
        if (i < dataArray.length - 1) await delay(intervalo);
    }

    // Reportar a hoja
    await reportarResultadoMensajes(resultados, targetUrl);
    return resultados;
}

async function validarNumeros(dataArray, appScriptUrl) {
    if (!isConnected || !sockInstance) throw new Error('Bot no conectado');
    const resultados = [];
    for (const item of dataArray) {
        try {
            const jid = formatNumber(item.numero);
            if (!jid) {
                resultados.push({ posicion: item.posicion, estado: 'Invalido' });
                continue;
            }
            const check = await sockInstance.onWhatsApp(jid);
            const existe = check && check.length > 0 && check[0].exists;
            resultados.push({ posicion: item.posicion, estado: existe ? 'Valido' : 'No WhatsApp' });
            await delay(500);
        } catch (e) {
            resultados.push({ posicion: item.posicion, estado: 'Error' });
        }
    }
    await reportarValidacion(resultados, appScriptUrl || null);
    return resultados;
}

// ===== RUTAS =====
app.get('/', (req, res) => {
    res.send(`
    <html><head><title>TAX VELASCO</title></head><body style="font-family:Arial;text-align:center;background:#0f172a;color:white;padding:40px">
    <h1>🔥 TAX VELASCO BOT V6.0 - ONLINE 🔥</h1>
    <p>Estado: <b>${isConnected ? '✅ CONECTADO' : '⏳ Esperando QR'}</b> | Hoja: ${GOOGLE_SHEET_URL.substring(0,60)}...</p>
    <p>
        <a href="/qr" style="background:#25D366;color:white;padding:15px 30px;border-radius:10px;text-decoration:none;margin:10px;display:inline-block">VER QR</a>
        <a href="/grupos" style="background:#3b82f6;color:white;padding:15px 30px;border-radius:10px;text-decoration:none;margin:10px;display:inline-block">VER GRUPOS</a>
    </p>
    <p style="color:#94a3b8;margin-top:30px">Render Region: Oregon | Version: V6.0 Prod | Uptime: ${Math.floor(process.uptime())}s</p>
    </body></html>`);
});

app.get('/qr', async (req, res) => {
    if (isConnected) return res.send('<html><body style="text-align:center;font-family:Arial"><h1>✅ YA CONECTADO</h1><p><a href="/grupos">Ver grupos</a></p></body></html>');
    if (!qrCodeData) return res.send('<html><head><meta http-equiv="refresh" content="2"></head><body style="text-align:center;font-family:Arial"><h1>⏳ Generando QR TAX VELASCO...</h1><p>Se actualiza solo cada 2s</p></body></html>');
    try {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<html><body style="text-align:center;background:#111;color:white;font-family:Arial"><h1>📲 ESCANEA TAX VELASCO</h1><div style="background:white;padding:20px;display:inline-block;border-radius:20px;"><img src="${qrImage}" style="width:320px;height:320px;"/></div><p>WhatsApp > Dispositivos vinculados > Vincular</p><script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
    } catch (e) { res.send(e.message); }
});

app.get('/grupos', async (req, res) => {
    try {
        if (!isConnected) return res.json({ status: 'error', message: 'Bot no conectado. Ve a /qr' });
        const grupos = await obtenerGrupos();
        const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
        await reportarGruposAHoja(mensajes);
        res.json({ status: '0', total: grupos.length, mensajes: mensajes });
    } catch (e) {
        res.json({ status: 'error', message: e.message });
    }
});

app.post('/iniciarqr', async (req, res) => {
    console.log('--- /iniciarqr ---', JSON.stringify(req.body).substring(0, 800));
    let incomingAppScript = req.body.app_script || '';
    let token_qr = req.body.token_qr || '';

    // Actualizar hoja vinculada si es valida y no es bucle
    if (incomingAppScript && incomingAppScript.includes('script.google.com') && !incomingAppScript.includes('onrender.com')) {
        sheetToNotify = incomingAppScript;
        GOOGLE_SHEET_URL = incomingAppScript;
        console.log('Hoja vinculada actualizada');
    } else if (incomingAppScript.includes('onrender.com')) {
        console.log('⚠️ BUCLE EVITADO: B1 tenia URL de Render, debe ser URL de Google');
    }

    // Restaurar sesion si viene token y no estamos conectados
    if (token_qr && !isConnected && !isStarting) {
        const restored = await restaurarSesionDesdeString(token_qr);
        if (restored) {
            console.log('Sesion restaurada, reiniciando bot...');
            // Reiniciar bot con nueva cred
            setTimeout(() => startBot(), 1000);
        }
    }

    const op = req.body.op || 'iniciarqr';
    const appUrl = (incomingAppScript && incomingAppScript.includes('script.google.com')) ? incomingAppScript : (sheetToNotify || GOOGLE_SHEET_URL);

    try {
        // 1. Recuperar GRUPOS (tu funcion recuperargrupos())
        if (op === 'registermessage' && req.body.grupos) {
            if (!isConnected) return res.json({ status: 'error', message: 'Bot no conectado. Escanea QR en /qr primero' });
            console.log('-> Recuperando GRUPOS para Sheet');
            const grupos = await obtenerGrupos();
            const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
            await reportarGruposAHoja(mensajes, appUrl);
            return res.json({ status: '0', message: `Grupos recuperados: ${mensajes.length}`, mensajes: mensajes });
        }

        // 2. Recuperar CONTACTOS
        if (op === 'registermessage' && req.body.contactos) {
            console.log('-> Recuperar contactos solicitado - Baileys no expone agenda completa, se devuelve OK');
            return res.json({ status: '0', message: 'Contactos: En Baileys los contactos se obtienen de chats activos. Usa Grupos.' });
        }

        // 3. Enviar MENSAJES MANUALES (MensajeManual y Programados)
        if (op === 'registermessage' && req.body.mensajes) {
            if (!isConnected) return res.json({ status: 'error', message: 'Bot no conectado' });
            console.log(`-> Enviando ${req.body.mensajes.length} mensajes`);
            // Responder inmediato para no bloquear Apps Script, enviar en background
            res.json({ status: '0', message: `Enviando ${req.body.mensajes.length} mensajes en segundo plano...` });
            // Enviar en background
            enviarMensajes(req.body.mensajes, appUrl).catch(e => console.log('Error env background', e.message));
            return;
        }

        // 4. Validar numeros
        if (op === 'registermessage' && req.body.validar_numero) {
            if (!isConnected) return res.json({ status: 'error', message: 'Bot no conectado' });
            console.log(`-> Validando ${req.body.validar_numero.length} numeros`);
            res.json({ status: '0', message: `Validando ${req.body.validar_numero.length} numeros...` });
            validarNumeros(req.body.validar_numero, appUrl).catch(e => console.log(e.message));
            return;
        }

        // 5. Agregar participantes a grupos
        if (op === 'registermessage' && req.body.grupocontactos) {
            if (!isConnected) return res.json({ status: 'error', message: 'Bot no conectado' });
            console.log('-> Agregar participantes a grupos');
            // Implementacion simplificada: buscar grupo por nombre
            try {
                const allGroups = await obtenerGrupos();
                const gruposMapByName = {};
                allGroups.forEach(g => { gruposMapByName[g.nombre] = g.id; });

                for (const grupoReq of req.body.grupocontactos) {
                    const groupId = gruposMapByName[grupoReq.nombregrupo] || grupoReq.nombregrupo; // si ya es ID
                    if (!groupId || !groupId.includes('@g.us')) {
                        console.log('Grupo no encontrado por nombre:', grupoReq.nombregrupo);
                        continue;
                    }
                    for (const reg of grupoReq.registros) {
                        const jid = formatNumber(reg.contacto);
                        if (!jid) continue;
                        try {
                            await sockInstance.groupParticipantsUpdate(groupId, [jid], 'add');
                            console.log(`Agregado ${jid} a ${grupoReq.nombregrupo}`);
                            await delay(2000);
                        } catch (e) {
                            console.log(`Error agregando ${jid}: ${e.message}`);
                        }
                    }
                }
                return res.json({ status: '0', message: 'Participantes agregados (revisa logs)' });
            } catch (e) {
                return res.json({ status: 'error', message: e.message });
            }
        }

        // 6. Grupos directo op=grupos
        if (op === 'grupos' || op === 'obtener_grupos' || op === 'getgroups') {
            if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
            const grupos = await obtenerGrupos();
            const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
            await reportarGruposAHoja(mensajes, appUrl);
            return res.json({ status: '0', mensajes: mensajes });
        }

        // 7. Iniciar QR normal
        if (isConnected) {
            await reportarAHoja('CONECTADO', 'ya_conectado', sockInstance?.user?.id || '');
            return res.json({ status: '0', message: 'Ya conectado ✅ - Listo para enviar y recuperar grupos' });
        }
        if (!isStarting) startBot();
        return res.json({ status: '0', message: 'Iniciando QR, revisa B2 o /qr' });

    } catch (e) {
        console.log('Error en /iniciarqr', e.message, e.stack);
        return res.json({ status: 'error', message: e.message });
    }
});

app.post('/grupos', async (req, res) => {
    req.url = '/iniciarqr';
    req.body = { ...req.body, op: 'registermessage', grupos: [{}], app_script: req.body.app_script || GOOGLE_SHEET_URL };
    return app.handle(req, res);
});

app.post('/', async (req, res) => {
    const op = req.body.op || '';
    console.log('POST / op:', op);
    if (['iniciarqr', 'registermessage', 'grupos', 'obtener_grupos', 'getgroups', 'resultado', 'gruposcontacto'].includes(op) || req.body.grupos || req.body.mensajes || req.body.validar_numero) {
        req.url = '/iniciarqr';
        return app.handle(req, res);
    }
    // Para doPost de qr que envia op=qr
    if (op === 'qr') {
        // Este es reporte desde el bot hacia si mismo? ignorar bucle
        return res.json({ status: '0' });
    }
    res.json({ status: '0', message: 'TAX VELASCO V6.0 online - Usa /iniciarqr' });
});

async function startBot() {
    if (isStarting) {
        console.log('Bot ya iniciando, evitando duplicado');
        return;
    }
    isStarting = true;
    try {
        console.log('Iniciando bot...');
        if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();
        console.log('WA version', version);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000
        });
        sockInstance = sock;

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            if (isConnected) {
                try {
                    if (fs.existsSync(CREDS_PATH)) {
                        const data = fs.readFileSync(CREDS_PATH, 'utf8');
                        await reportarAHoja('CONECTADO', data, sock.user?.id || '');
                    }
                } catch (e) { console.log('Error creds.update', e.message); }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                console.log('NUEVO QR GENERADO - Enviando a hoja');
                qrCodeData = qr;
                await reportarAHoja(qr);
            }
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const msg = lastDisconnect?.error?.message || '';
                console.log(`Conexion cerrada codigo:${code} msg:${msg}`);
                isConnected = false;
                qrCodeData = null;
                isStarting = false;
                const isConflict = String(msg).toLowerCase().includes('conflict') || String(msg).toLowerCase().includes('replaced');
                const isLoggedOut = code === DisconnectReason.loggedOut && !isConflict;
                if (isLoggedOut) {
                    console.log('Sesion cerrada por usuario, borrando creds');
                    try { if (fs.existsSync(CREDS_PATH)) fs.unlinkSync(CREDS_PATH); } catch {}
                } else {
                    console.log('Reintentando en 5s...');
                    setTimeout(() => startBot(), 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ TAX VELASCO CONECTADO CON EXITO - Listo para grupos y mensajes');
                isConnected = true;
                qrCodeData = null;
                isStarting = false;
                try {
                    const data = fs.existsSync(CREDS_PATH) ? fs.readFileSync(CREDS_PATH, 'utf8') : JSON.stringify(state.creds);
                    await reportarAHoja('CONECTADO', data, sock.user?.id || '');
                } catch (e) { console.log('Error reporte conectado', e.message); }
            }
        });

        // Opcional: escuchar mensajes entrantes (para tu bot futuro)
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (!m.message || m.key.fromMe) continue;
                // console.log('Mensaje entrante:', m.message.conversation || m.message.extendedTextMessage?.text || '[media]');
            }
        });

    } catch (e) {
        console.log('Error startBot', e.message, e.stack);
        isStarting = false;
        setTimeout(() => startBot(), 10000);
    } finally {
        // isStarting se resetea en open/close, pero por si acaso
        if (!isConnected && !qrCodeData) {
            setTimeout(() => { isStarting = false; }, 5000);
        }
    }
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`V6.0 puerto ${PORT} - 0.0.0.0`);
    startBot();
});
