const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, delay } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const axios = require('axios');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
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

let GOOGLE_SHEET_URL = (process.env.GOOGLE_SHEET_URL && !process.env.GOOGLE_SHEET_URL.includes('AKfycbx09J') && !process.env.GOOGLE_SHEET_URL.includes('onrender.com')
    ? process.env.GOOGLE_SHEET_URL
    : 'https://script.google.com/macros/s/AKfycbx7BQTSU3yIwItZnKfKepL-IgWzmDnPHBxI4iVCJU9Yn0W4WX-zmugptwZBMoJSW4NH/exec');
let sheetToNotify = null;

let qrCodeData = null;
let isConnected = false;
let sockInstance = null;
let isStarting = false;

// ===== BOT IA CONFIG =====
let botIAConfig = {
    enabled: false,
    tipo: '', // BOT API GPT, BOT Asistente GPT, BOT Asistente DEEPSEEK, GEMINI, etc
    token: '',
    modelo: 'gpt-4o-mini',
    entrenamiento: '',
    gmt: 'GMT-5',
    blacklist: '',
    whitelist: '',
    lastUpdate: null
};

console.log('=================================================');
console.log('TAX VELASCO V7.0 - CON IA + GRUPOS - RENDER');
console.log('Sheet:', GOOGLE_SHEET_URL.substring(0,80));
console.log('IA ENV:', {
    openai: !!process.env.OPENAI_API_KEY,
    deepseek: !!process.env.DEEPSEEK_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY
});
console.log('=================================================');

if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

function formatNumber(numero) {
    if (!numero) return null;
    let num = ('' + numero).replace(/[^0-9]/g, '');
    if (!num) return null;
    if (num.startsWith('0')) num = num.substring(1);
    if (num.length === 9 && num.startsWith('9')) num = '593' + num;
    return num + '@s.whatsapp.net';
}

// ===== SHEET COMUNICACION =====
async function reportarAHoja(qr, session = '', numero = '') {
    const targetUrl = sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl || targetUrl.includes('onrender.com') || targetUrl.includes('AKfycbx09J')) return;
    try {
        await axios.post(targetUrl, { op: 'qr', qr, session, numero }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        console.log('Reporte QR OK');
    } catch (e) { console.log('Error reporte QR', e.message); }
}

async function reportarGruposAHoja(mensajesGrupos, overrideUrl = null) {
    const targetUrl = overrideUrl || sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl || targetUrl.includes('onrender.com')) return;
    try {
        await axios.post(targetUrl, { op: 'grupos', mensajes: mensajesGrupos }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
        console.log(`Grupos ${mensajesGrupos.length} reportados OK`);
    } catch (e) { console.log('Error grupos', e.message); }
}

async function obtenerConfigDesdeHoja() {
    const targetUrl = sheetToNotify || GOOGLE_SHEET_URL;
    try {
        console.log('Obteniendo configuracion desde hoja...');
        const resp = await axios.post(targetUrl, { op: 'obtenersheet' }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
        const data = resp.data;
        if (data && data.configuracion) {
            const cfg = data.configuracion;
            // cfg es array 2D como rows_config
            // Row 8 col2 = tipo bot => cfg[7][1]
            // Row 8 col4 = token => cfg[7][3]
            // Row 8 col6 = ID Asistente => cfg[7][5]
            // Row 9 col2 = entrenamiento => cfg[8][1]
            // Row 9 col8 = modelo => cfg[8][7]
            // Row 5 col2 = gmt => cfg[4][1]
            botIAConfig.tipo = (cfg[7] && cfg[7][1] ? '' + cfg[7][1] : botIAConfig.tipo);
            botIAConfig.token = (cfg[7] && cfg[7][3] ? '' + cfg[7][3] : botIAConfig.token);
            botIAConfig.modelo = (cfg[8] && cfg[8][7] ? '' + cfg[8][7] : botIAConfig.modelo) || 'gpt-4o-mini';
            botIAConfig.entrenamiento = (cfg[8] && cfg[8][1] ? '' + cfg[8][1] : botIAConfig.entrenamiento);
            botIAConfig.gmt = (cfg[4] && cfg[4][1] ? '' + cfg[4][1] : 'GMT-5');
            botIAConfig.blacklist = data.blacklist || '';
            botIAConfig.whitelist = data.whitelist || '';
            botIAConfig.lastUpdate = new Date();
            console.log(`Config IA cargada: tipo=${botIAConfig.tipo} modelo=${botIAConfig.modelo} token=${botIAConfig.token ? 'SI(' + botIAConfig.token.length + ' chars)' : 'NO'}`);
            return true;
        }
    } catch (e) {
        console.log('Error obteniendo config', e.message);
    }
    return false;
}

async function callFindConversacion(numero, texto) {
    const targetUrl = sheetToNotify || GOOGLE_SHEET_URL;
    try {
        const resp = await axios.post(targetUrl, { op: 'find_conversacion', numero: numero, mensaje: texto }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        return resp.data;
    } catch (e) {
        console.log('Error find_conversacion', e.message);
        return { status: '-1' };
    }
}

// ===== IA CALLS =====
async function llamarIA(textoUsuario, numero) {
    // Prioridad: token de hoja > ENV
    const tipo = (botIAConfig.tipo || '').toUpperCase();
    let token = botIAConfig.token || '';
    let modelo = botIAConfig.modelo || 'gpt-4o-mini';
    const systemPrompt = botIAConfig.entrenamiento || 'Eres un asistente util de TAX VELASCO. Responde de forma amable y breve.';

    // Fallback a ENV
    if (!token) {
        if (tipo.includes('DEEPSEEK') && process.env.DEEPSEEK_API_KEY) token = process.env.DEEPSEEK_API_KEY;
        else if (tipo.includes('GEMINI') && process.env.GEMINI_API_KEY) token = process.env.GEMINI_API_KEY;
        else if (process.env.OPENAI_API_KEY) token = process.env.OPENAI_API_KEY;
    }

    if (!token) {
        console.log('No hay token IA configurado');
        return null;
    }

    try {
        // ===== GEMINI =====
        if (tipo.includes('GEMINI')) {
            const gemModel = modelo.includes('gemini') ? modelo : 'gemini-1.5-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:generateContent?key=${token}`;
            const resp = await axios.post(url, {
                contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\nUsuario (' + numero + '): ' + textoUsuario }] }]
            }, { timeout: 30000 });
            const out = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return out;
        }

        // ===== DEEPSEEK (OpenAI compatible) =====
        if (tipo.includes('DEEPSEEK')) {
            const url = 'https://api.deepseek.com/v1/chat/completions';
            const resp = await axios.post(url, {
                model: modelo.includes('deepseek') ? modelo : 'deepseek-chat',
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: textoUsuario }],
                temperature: 0.7
            }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 });
            return resp.data?.choices?.[0]?.message?.content || '';
        }

        // ===== GROK (X.AI) =====
        if (tipo.includes('GROK')) {
            const url = 'https://api.x.ai/v1/chat/completions';
            const resp = await axios.post(url, {
                model: modelo.includes('grok') ? modelo : 'grok-2-latest',
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: textoUsuario }]
            }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 });
            return resp.data?.choices?.[0]?.message?.content || '';
        }

        // ===== OPENAI / GPT / QWEN / MISTRAL / LLAMA (OpenAI compatible) =====
        // QWEN, MISTRAL, etc pueden usar OpenAI endpoint si tienen token compatible
        let apiUrl = 'https://api.openai.com/v1/chat/completions';
        let useModel = modelo;
        
        if (tipo.includes('QWEN')) {
            apiUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
            useModel = modelo.includes('qwen') ? modelo : 'qwen-plus';
        }

        const resp = await axios.post(apiUrl, {
            model: useModel,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: textoUsuario }],
            temperature: 0.7,
            max_tokens: 1000
        }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 });
        
        return resp.data?.choices?.[0]?.message?.content || '';

    } catch (e) {
        console.log('Error IA:', e.response?.data || e.message);
        // Si falla, devolver mensaje de error amigable
        if (e.response?.status === 401) return '⚠️ Token de IA invalido o expirado. Verifica en Configuracion!D8';
        if (e.response?.status === 429) return '⚠️ Limite de IA alcanzado, intenta en 1 minuto';
        return null;
    }
}

// ===== GRUPOS Y MENSAJES =====
async function obtenerGrupos() {
    if (!isConnected || !sockInstance) throw new Error('Bot no conectado');
    const groupsMap = await sockInstance.groupFetchAllParticipating();
    return Object.values(groupsMap).map(g => ({ id: g.id, nombre: g.subject, participantes: g.participants?.length || 0 }));
}

async function enviarMensajes(dataArray, appScriptUrl) {
    if (!isConnected || !sockInstance) throw new Error('No conectado');
    const resultados = [];
    for (let i = 0; i < dataArray.length; i++) {
        const item = dataArray[i];
        const posicion = item.posicion || i.toString();
        let estado = 'Enviado';
        try {
            const jid = formatNumber(item.numero);
            if (!jid) throw new Error('Numero invalido');
            let mensaje = item.mensaje || '';
            let url = item.url || '';
            if (url && url.startsWith('http')) {
                const low = url.toLowerCase();
                if (low.match(/\.(jpg|jpeg|png|gif|webp)$/)) await sockInstance.sendMessage(jid, { image: { url }, caption: mensaje });
                else if (low.match(/\.(mp4|mov)$/)) await sockInstance.sendMessage(jid, { video: { url }, caption: mensaje });
                else await sockInstance.sendMessage(jid, { document: { url }, mimetype: 'application/pdf', fileName: 'doc.pdf', caption: mensaje });
            } else if (mensaje) {
                await sockInstance.sendMessage(jid, { text: mensaje });
            }
        } catch (e) { estado = 'Error: ' + e.message.substring(0,80); }
        resultados.push({ posicion, estado });
        let intervalo = item.intervalo_mensaje ? parseInt(item.intervalo_mensaje)*1000 : 2500 + Math.random()*2000;
        if (i < dataArray.length-1) await delay(intervalo);
    }
    const targetUrl = appScriptUrl || sheetToNotify || GOOGLE_SHEET_URL;
    try { await axios.post(targetUrl, { op: 'resultado', mensajes: resultados }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }); } catch {}
    return resultados;
}

// ===== RUTAS =====
app.get('/', (req,res)=> res.send(`<html><body style="font-family:Arial;text-align:center;background:#0f172a;color:white;padding:30px"><h1>🔥 TAX VELASCO V7.0 CON IA 🔥</h1><p>Estado: <b>${isConnected ? '✅ CONECTADO' : '⏳ QR'}</b> | IA: <b>${botIAConfig.enabled ? '✅ ' + botIAConfig.tipo + ' (' + botIAConfig.modelo + ')' : '❌ Desactivado'}</b></p><p><a href="/qr" style="background:#25D366;color:white;padding:12px 25px;border-radius:8px;text-decoration:none;margin:5px">QR</a><a href="/grupos" style="background:#3b82f6;color:white;padding:12px 25px;border-radius:8px;text-decoration:none;margin:5px">GRUPOS</a><a href="/bot-status" style="background:#8b5cf6;color:white;padding:12px 25px;border-radius:8px;text-decoration:none;margin:5px">ESTADO IA</a></p></body></html>`));

app.get('/bot-status', (req,res)=> res.json({ status: '0', conectado: isConnected, ia: botIAConfig }));

app.get('/qr', async (req,res)=>{
    if (isConnected) return res.send('<h1>✅ CONECTADO</h1><p><a href="/grupos">Grupos</a> | <a href="/bot-status">IA Status</a></p>');
    if (!qrCodeData) return res.send('<html><head><meta http-equiv="refresh" content="2"></head><body style="text-align:center"><h1>⏳ Generando QR...</h1></body></html>');
    try {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<html><body style="text-align:center;background:#111;color:white"><h1>ESCANEA TAX VELASCO V7</h1><div style="background:white;padding:20px;display:inline-block;border-radius:20px;"><img src="${qrImage}" style="width:320px;height:320px;"/></div><script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
    } catch(e){ res.send(e.message); }
});

app.get('/grupos', async (req,res)=>{
    try {
        if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
        const grupos = await obtenerGrupos();
        const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
        await reportarGruposAHoja(mensajes);
        res.json({ status: '0', total: grupos.length, mensajes });
    } catch(e){ res.json({ status: 'error', message: e.message }); }
});

app.post('/iniciarqr', async (req,res)=>{
    console.log('--- /iniciarqr op:', req.body.op, ' tipo:', req.body.tipobot || '', ' ---');
    let incomingAppScript = req.body.app_script || '';
    if (incomingAppScript && incomingAppScript.includes('script.google.com') && !incomingAppScript.includes('onrender.com')) {
        sheetToNotify = incomingAppScript; GOOGLE_SHEET_URL = incomingAppScript;
    }

    const op = req.body.op || 'iniciarqr';

    try {
        // 1. Iniciar/Actualizar BOT IA
        if (req.body.tipobot || req.body.conversacion_bot || (op === 'registermessage' && req.body.sheet_id)) {
            console.log('-> Solicitud INICIAR BOT IA:', req.body.tipobot, req.body.tipored);
            // Obtener config completa desde hoja
            await obtenerConfigDesdeHoja();
            botIAConfig.enabled = true;
            if (req.body.tipobot) botIAConfig.tipo = req.body.tipobot;
            console.log('✅ BOT IA ACTIVADO:', botIAConfig.tipo, 'Modelo:', botIAConfig.modelo);
            if (!isConnected && !isStarting) startBot();
            return res.json({ status: '0', message: `BOT IA ${botIAConfig.tipo} Activado ✅ Modelo ${botIAConfig.modelo}. Ya responde mensajes.` });
        }

        // 2. Grupos
        if (op === 'registermessage' && req.body.grupos) {
            if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
            const grupos = await obtenerGrupos();
            const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
            await reportarGruposAHoja(mensajes, incomingAppScript || null);
            return res.json({ status: '0', mensajes });
        }

        // 3. Mensajes manuales
        if (op === 'registermessage' && req.body.mensajes) {
            if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
            res.json({ status: '0', message: `Enviando ${req.body.mensajes.length}...` });
            enviarMensajes(req.body.mensajes, incomingAppScript || null).catch(()=>{});
            return;
        }

        // 4. Grupos directo
        if (['grupos','obtener_grupos','getgroups'].includes(op)) {
            if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
            const grupos = await obtenerGrupos();
            const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
            await reportarGruposAHoja(mensajes, incomingAppScript || null);
            return res.json({ status: '0', mensajes });
        }

        // 5. Iniciar QR
        if (isConnected) {
            await reportarAHoja('CONECTADO', 'ya_conectado', sockInstance?.user?.id || '');
            return res.json({ status: '0', message: 'Ya conectado ✅ IA: ' + (botIAConfig.enabled ? botIAConfig.tipo : 'Desactivado (dale Iniciar BOT en Sheet)') });
        }
        if (!isStarting) startBot();
        return res.json({ status: '0', message: 'Iniciando QR...' });

    } catch (e) {
        console.log('Error /iniciarqr', e.message);
        return res.json({ status: 'error', message: e.message });
    }
});

app.post('/grupos', async (req,res)=>{ req.url='/iniciarqr'; req.body={...req.body, op:'registermessage', grupos:[{}]}; return app.handle(req,res); });
app.post('/', async (req,res)=>{
    const op = req.body.op || '';
    if (['iniciarqr','registermessage','grupos','obtenersheet','find_conversacion'].includes(op) || req.body.grupos || req.body.mensajes || req.body.tipobot) {
        req.url='/iniciarqr'; return app.handle(req,res);
    }
    res.json({ status: '0', message: 'V7.0 online' });
});

async function startBot(){
    if (isStarting) return;
    isStarting = true;
    try {
        if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();
        console.log('WA version', version);
        const sock = makeWASocket({ version, auth: state, logger: P({level:'silent'}), browser: Browsers.macOS('Desktop'), syncFullHistory:false, markOnlineOnConnect:false, connectTimeoutMs:60000 });
        sockInstance = sock;

        sock.ev.on('creds.update', async ()=>{
            await saveCreds();
            if (isConnected && fs.existsSync(CREDS_PATH)) {
                try { const data = fs.readFileSync(CREDS_PATH,'utf8'); await reportarAHoja('CONECTADO', data, sock.user?.id||''); } catch {}
            }
        });

        sock.ev.on('connection.update', async (update)=>{
            const { connection, lastDisconnect, qr } = update;
            if (qr) { qrCodeData = qr; await reportarAHoja(qr); console.log('QR generado'); }
            if (connection==='close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const msg = lastDisconnect?.error?.message || '';
                console.log(`Cerrada ${code} ${msg}`);
                isConnected = false; qrCodeData = null; isStarting = false;
                const isConflict = String(msg).toLowerCase().includes('conflict') || String(msg).toLowerCase().includes('replaced');
                const isLoggedOut = code===DisconnectReason.loggedOut && !isConflict;
                if (!isLoggedOut) setTimeout(()=>startBot(),5000);
            } else if (connection==='open') {
                console.log('✅ CONECTADO CON EXITO - IA:', botIAConfig.enabled ? botIAConfig.tipo : 'desactivada (dale Iniciar BOT en Sheet)');
                isConnected = true; qrCodeData = null; isStarting = false;
                // Cargar config al conectar
                await obtenerConfigDesdeHoja();
                try {
                    const data = fs.existsSync(CREDS_PATH) ? fs.readFileSync(CREDS_PATH,'utf8') : JSON.stringify(state.creds);
                    await reportarAHoja('CONECTADO', data, sock.user?.id||'');
                } catch {}
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            if (!botIAConfig.enabled) return; // Si no han dado Iniciar BOT, no responde
            for (const m of messages) {
                try {
                    if (!m.message || m.key.fromMe) continue;
                    const from = m.key.remoteJid;
                    if (from.includes('@g.us') && !botIAConfig.tipo.includes('GRUPO')) {
                        // Si es grupo y no esta configurado para grupos, ignorar segun Configuracion!D6?
                        // Por ahora responder tambien en grupos si esta activado
                    }
                    const texto = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';
                    if (!texto) continue;
                    const numero = from.split('@')[0];
                    
                    // Blacklist check
                    if (botIAConfig.blacklist && botIAConfig.blacklist.includes(numero)) {
                        console.log('Numero en blacklist, ignorado', numero);
                        continue;
                    }

                    console.log(`📩 Mensaje de ${numero}: ${texto.substring(0,80)}`);

                    // 1. Intentar AutoResponder (Conversacion sheet)
                    let respuesta = null;
                    try {
                        const convResp = await callFindConversacion(numero, texto);
                        if (convResp && convResp.status === '0' && convResp.mensajes && convResp.mensajes.length > 0) {
                            // Tiene respuesta de Conversacion sheet
                            console.log('Respuesta desde Conversacion sheet');
                            for (const msgObj of convResp.mensajes) {
                                const outText = msgObj.mensaje_salida || msgObj.mensaje || '';
                                if (outText) {
                                    // Manejar <url>, <mapa> etc - simplificado
                                    let clean = outText.replace(/<url>.*?<\/url>/g, '').replace(/<mapa>.*?<\/mapa>/g, '').trim();
                                    if (clean) await sock.sendMessage(from, { text: clean });
                                    await delay(1000);
                                }
                            }
                            continue; // Ya respondio via conversacion
                        }
                    } catch (e) { console.log('Error conversacion sheet', e.message); }

                    // 2. Si no hay conversacion, usar IA si esta configurada
                    if (botIAConfig.tipo && !botIAConfig.tipo.includes('AutoResponder')) {
                        console.log('Llamando IA', botIAConfig.tipo, 'para', numero);
                        const iaResp = await llamarIA(texto, numero);
                        if (iaResp) {
                            await sock.sendMessage(from, { text: iaResp });
                            console.log('✅ Respuesta IA enviada');
                        } else {
                            console.log('IA no devolvio respuesta');
                        }
                    }

                } catch (e) {
                    console.log('Error en messages.upsert', e.message);
                }
            }
        });

    } catch (e) {
        console.log('Error startBot', e.message);
        isStarting = false;
        setTimeout(()=>startBot(), 10000);
    }
}

app.listen(PORT, '0.0.0.0', ()=>{ console.log(`V7.0 IA puerto ${PORT}`); startBot(); });
