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

// Token leido desde ENV o Google Sheet D8 - NUNCA hardcodear aqui
const NUEVO_TOKEN_IA_USUARIO = process.env.MISTRAL_API_KEY || process.env.AI_TOKEN || '';

let botIAConfig = {
    enabled: false,
    tipo: '',
    token: NUEVO_TOKEN_IA_USUARIO || '',
    modelo: 'pixtral-large-latest',
    entrenamiento: '',
    gmt: 'GMT-5',
    blacklist: '',
    whitelist: '',
    lastUpdate: null
};

console.log('=================================================');
console.log('TAX VELASCO V7.3 - CON IA ENV + GRUPOS - FIX SECRET SCAN');
console.log('Token IA desde ENV: ' + (NUEVO_TOKEN_IA_USUARIO ? 'SI ('+NUEVO_TOKEN_IA_USUARIO.length+' chars) prefix='+NUEVO_TOKEN_IA_USUARIO.substring(0,3) : 'NO - usando Sheet D8'));
console.log('Sheet:', GOOGLE_SHEET_URL.substring(0,80));
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
            botIAConfig.tipo = (cfg[7] && cfg[7][1] ? '' + cfg[7][1] : botIAConfig.tipo);
            botIAConfig.modelo = (cfg[8] && cfg[8][7] ? '' + cfg[8][7] : botIAConfig.modelo) || 'gpt-4o-mini';
            botIAConfig.entrenamiento = (cfg[8] && cfg[8][1] ? '' + cfg[8][1] : botIAConfig.entrenamiento);
            botIAConfig.gmt = (cfg[4] && cfg[4][1] ? '' + cfg[4][1] : 'GMT-5');
            botIAConfig.blacklist = data.blacklist || '';
            botIAConfig.whitelist = data.whitelist || '';
            botIAConfig.lastUpdate = new Date();
            // Si el Sheet tiene token viejo sk-proj (OpenAI sin saldo), NO sobreescribir con ese, mantener AQ.
            const sheetToken = cfg[7] && cfg[7][3] ? ('' + cfg[7][3]).trim() : '';
            if (sheetToken) {
                // Si sheetToken es el nuevo AQ o es diferente al viejo, actualizar. Si es sk-proj viejo y ya tenemos AQ, mantener AQ
                const esSheetOpenAI = sheetToken.startsWith('sk-');
                const esActualAQ = botIAConfig.token && botIAConfig.token.startsWith('AQ.');
                if (!(esSheetOpenAI && esActualAQ)) {
                    // Solo sobrescribir si no es el caso de OpenAI viejo sobre AQ nuevo
                    botIAConfig.token = sheetToken;
                } else {
                    console.log('Sheet tiene token OpenAI viejo sk-... manteniendo nuevo token AQ.');
                }
            }
            console.log(`Config IA cargada: tipo=${botIAConfig.tipo} modelo=${botIAConfig.modelo} token=${botIAConfig.token ? 'SI('+botIAConfig.token.length+' chars) prefix='+botIAConfig.token.substring(0,3) : 'NO'}`);
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
        return { status: '-1' };
    }
}

async function llamarIA(textoUsuario, numero) {
    const tipo = (botIAConfig.tipo || '').toUpperCase();
    let token = botIAConfig.token || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.GEMINI_API_KEY || '';
    let modelo = botIAConfig.modelo || 'gpt-4o-mini';
    const systemPrompt = botIAConfig.entrenamiento || 'Eres asistente util de TAX VELASCO. Responde breve y amable.';

    // Si el token empieza con AQ. es de MISTRAL
    let esTokenMistralAQ = token.startsWith('AQ.');

    if (!token) return null;

    try {
        // ===== MISTRAL con token AQ. (tu nuevo token) =====
        if (tipo.includes('MISTRAL') || esTokenMistralAQ || modelo.includes('pixtral') || modelo.includes('mistral')) {
            const mistralModel = modelo.includes('pixtral') || modelo.includes('mistral') ? modelo : 'pixtral-large-latest';
            // Mistral endpoint
            const resp = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                model: mistralModel,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: textoUsuario }],
                temperature: 0.7
            }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 });
            return resp.data?.choices?.[0]?.message?.content || '';
        }

        if (tipo.includes('GEMINI')) {
            const gemModel = modelo.includes('gemini') ? modelo : 'gemini-1.5-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:generateContent?key=${token}`;
            const resp = await axios.post(url, { contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\nUsuario: ' + textoUsuario }] }] }, { timeout: 30000 });
            return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
        if (tipo.includes('DEEPSEEK')) {
            const resp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: modelo.includes('deepseek') ? modelo : 'deepseek-chat',
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: textoUsuario }],
            }, { headers: { 'Authorization': `Bearer ${token}` }, timeout: 30000 });
            return resp.data?.choices?.[0]?.message?.content || '';
        }
        // OPENAI por defecto
        const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: modelo,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: textoUsuario }],
            temperature: 0.7, max_tokens: 1000
        }, { headers: { 'Authorization': `Bearer ${token}` }, timeout: 30000 });
        return resp.data?.choices?.[0]?.message?.content || '';
    } catch (e) {
        const status = e.response?.status;
        const data = e.response?.data;
        console.log('Error IA:', status, JSON.stringify(data || {}).substring(0,500), e.message);
        if (status === 401) {
            const detalle = data?.message || data?.error?.message || 'No autorizado';
            return `⚠️ TOKEN IA INVALIDO (${token.substring(0,10)}...): ${detalle}. Verifica en https://console.mistral.ai/api-keys - Tu token actual es ${token.length} chars, debe ser de Mistral. Si es de otro proveedor, cambia B8 a BOT API GPT / DEEPSEEK / GEMINI segun tu token.`;
        }
        if (data?.error?.code === 'insufficient_quota') return '⚠️ Sin saldo OpenAI. Recarga en platform.openai.com/billing o cambia a DeepSeek/Gemini';
        if (status === 429) return '⚠️ Rate limit IA, intenta en 30s';
        return `⚠️ Error IA ${status}: ${(data?.message || e.message).substring(0,200)}`;
    }
}

async function obtenerGrupos() {
    if (!isConnected || !sockInstance) throw new Error('No conectado');
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
                if (low.match(/\.(jpg|jpeg|png)$/)) await sockInstance.sendMessage(jid, { image: { url }, caption: mensaje });
                else await sockInstance.sendMessage(jid, { text: (mensaje ? mensaje + '\n' + url : url) });
            } else if (mensaje) {
                await sockInstance.sendMessage(jid, { text: mensaje });
            }
        } catch (e) { estado = 'Error: ' + e.message.substring(0,80); }
        resultados.push({ posicion, estado });
        let intervalo = item.intervalo_mensaje ? parseInt(item.intervalo_mensaje)*1000 : 2500;
        if (i < dataArray.length-1) await delay(intervalo);
    }
    const targetUrl = appScriptUrl || sheetToNotify || GOOGLE_SHEET_URL;
    try { await axios.post(targetUrl, { op: 'resultado', mensajes: resultados }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }); } catch {}
    return resultados;
}

app.get('/', (req,res)=> res.send(`<h1>TAX VELASCO V7.0 IA</h1><p>Estado: ${isConnected ? 'CONECTADO' : 'QR'} | IA: ${botIAConfig.enabled ? botIAConfig.tipo : 'Desactivado'}</p><p><a href="/qr">QR</a> | <a href="/grupos">GRUPOS</a> | <a href="/bot-status">IA STATUS</a></p>`));
app.get('/bot-status', (req,res)=> res.json({ conectado: isConnected, ia: botIAConfig }));
app.get('/qr', async (req,res)=>{
    if (isConnected) return res.send('<h1>YA CONECTADO</h1>');
    if (!qrCodeData) return res.send('<html><head><meta http-equiv="refresh" content="2"></head><body><h1>Generando QR...</h1></body></html>');
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.send(`<html><body style="text-align:center;background:#111;color:white"><h1>ESCANEA V7</h1><div style="background:white;padding:20px;display:inline-block;border-radius:20px;"><img src="${qrImage}" style="width:320px;height:320px;"/></div></body></html>`);
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
    console.log('--- /iniciarqr op:', req.body.op, ' ---');
    let incomingAppScript = req.body.app_script || '';
    if (incomingAppScript && incomingAppScript.includes('script.google.com') && !incomingAppScript.includes('onrender.com')) {
        sheetToNotify = incomingAppScript; GOOGLE_SHEET_URL = incomingAppScript;
    }
    const op = req.body.op || 'iniciarqr';
    try {
        if (req.body.tipobot || req.body.conversacion_bot || (op === 'registermessage' && req.body.sheet_id)) {
            await obtenerConfigDesdeHoja();
            botIAConfig.enabled = true;
            if (req.body.tipobot) botIAConfig.tipo = req.body.tipobot;
            console.log('✅ BOT IA ACTIVADO:', botIAConfig.tipo);
            return res.json({ status: '0', message: `BOT IA ${botIAConfig.tipo} Activado` });
        }
        if (op === 'registermessage' && req.body.grupos) {
            if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
            const grupos = await obtenerGrupos();
            const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
            await reportarGruposAHoja(mensajes, incomingAppScript || null);
            return res.json({ status: '0', mensajes });
        }
        if (op === 'registermessage' && req.body.mensajes) {
            if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
            res.json({ status: '0', message: `Enviando ${req.body.mensajes.length}...` });
            enviarMensajes(req.body.mensajes, incomingAppScript || null).catch(()=>{});
            return;
        }
        if (['grupos','obtener_grupos','getgroups'].includes(op)) {
            if (!isConnected) return res.json({ status: 'error', message: 'No conectado' });
            const grupos = await obtenerGrupos();
            const mensajes = grupos.map(g => ({ id_grupo: g.id, nombre_grupo: g.nombre }));
            await reportarGruposAHoja(mensajes, incomingAppScript || null);
            return res.json({ status: '0', mensajes });
        }
        if (isConnected) {
            await reportarAHoja('CONECTADO', 'ya_conectado', sockInstance?.user?.id || '');
            return res.json({ status: '0', message: 'Ya conectado' });
        }
        if (!isStarting) startBot();
        return res.json({ status: '0', message: 'Iniciando QR...' });
    } catch (e) {
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
        const sock = makeWASocket({ version, auth: state, logger: P({level:'silent'}), browser: Browsers.macOS('Desktop'), syncFullHistory:false, markOnlineOnConnect:false });
        sockInstance = sock;
        sock.ev.on('creds.update', async ()=>{
            await saveCreds();
            if (isConnected && fs.existsSync(CREDS_PATH)) {
                try { const data = fs.readFileSync(CREDS_PATH,'utf8'); await reportarAHoja('CONECTADO', data, sock.user?.id||''); } catch {}
            }
        });
        sock.ev.on('connection.update', async (update)=>{
            const { connection, lastDisconnect, qr } = update;
            if (qr) { qrCodeData = qr; await reportarAHoja(qr); }
            if (connection==='close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const msg = lastDisconnect?.error?.message || '';
                console.log(`Cerrada ${code} ${msg}`);
                isConnected = false; qrCodeData = null; isStarting = false;
                const isConflict = String(msg).toLowerCase().includes('conflict');
                const isLoggedOut = code===DisconnectReason.loggedOut && !isConflict;
                if (!isLoggedOut) setTimeout(()=>startBot(),5000);
            } else if (connection==='open') {
                console.log('✅ CONECTADO - IA:', botIAConfig.enabled ? botIAConfig.tipo : 'dale Iniciar BOT');
                isConnected = true; qrCodeData = null; isStarting = false;
                await obtenerConfigDesdeHoja();
                try {
                    const data = fs.existsSync(CREDS_PATH) ? fs.readFileSync(CREDS_PATH,'utf8') : JSON.stringify(state.creds);
                    await reportarAHoja('CONECTADO', data, sock.user?.id||'');
                } catch {}
            }
        });
        sock.ev.on('messages.upsert', async ({ messages }) => {
            if (!botIAConfig.enabled) return;
            for (const m of messages) {
                try {
                    if (!m.message || m.key.fromMe) continue;
                    const from = m.key.remoteJid;
                    const texto = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || '';
                    if (!texto) continue;
                    const numero = from.split('@')[0];
                    if (botIAConfig.blacklist && botIAConfig.blacklist.includes(numero)) continue;
                    console.log(`📩 ${numero}: ${texto.substring(0,80)}`);
                    try {
                        const convResp = await callFindConversacion(numero, texto);
                        if (convResp && convResp.status === '0' && convResp.mensajes?.length > 0) {
                            for (const msgObj of convResp.mensajes) {
                                const outText = msgObj.mensaje_salida || '';
                                if (outText) {
                                    let clean = outText.replace(/<url>.*?<\/url>/g,'').trim();
                                    if (clean) await sock.sendMessage(from, { text: clean });
                                    await delay(1000);
                                }
                            }
                            continue;
                        }
                    } catch {}
                    if (botIAConfig.tipo && !botIAConfig.tipo.includes('AutoResponder')) {
                        const iaResp = await llamarIA(texto, numero);
                        if (iaResp) await sock.sendMessage(from, { text: iaResp });
                    }
                } catch (e) { console.log('Error mensaje', e.message); }
            }
        });
    } catch (e) {
        console.log('Error startBot', e.message);
        isStarting = false;
        setTimeout(()=>startBot(), 10000);
    }
}

app.listen(PORT, '0.0.0.0', ()=>{ console.log(`V7.1 IA NUEVO TOKEN puerto ${PORT}`); startBot(); });
