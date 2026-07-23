const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const axios = require('axios');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
let GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || ''; // Tu APPSCRIPT de la hoja Configuracion!B1

let qrCodeData = null;
let isConnected = false;
let sockInstance = null;
let sheetToNotify = null; // URL del AppScript donde reportar QR y sesion

console.log('TAX VELASCO V4 - Integracion con Google Sheet');

// Funcion que reporta a tu hoja de calculo
async function reportarAHoja(qr, session = '', numero = '') {
    const targetUrl = sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl) {
        console.log('No hay GOOGLE_SHEET_URL configurada, solo muestro QR local');
        return;
    }
    try {
        console.log(`Reportando a hoja: QR=${qr?.substring(0,20)}... session=${session ? 'SI' : 'NO'} numero=${numero}`);
        const payload = {
            op: 'qr',
            qr: qr,
            session: session,
            numero: numero
        };
        // Tu funcion generar(qr) en Apps Script espera: qr.qr , qr.session , qr.numero
        await axios.post(targetUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        console.log('Reporte a hoja OK');
    } catch (e) {
        console.log('Error reportando a hoja:', e.message);
    }
}

app.get('/', (req, res) => {
    res.send(`<h1>TAX VELASCO V4 ONLINE</h1><p>Estado: ${isConnected ? 'CONECTADO' : 'Esperando QR'}<br>Hoja vinculada: ${sheetToNotify || GOOGLE_SHEET_URL || 'No configurada'}</p><p><a href="/qr">VER QR LOCAL</a></p>`);
});

app.get('/qr', async (req, res) => {
    if (isConnected) return res.send('<h1>TAX VELASCO YA CONECTADO</h1><p>Revisa tu hoja Configuracion!B2 debe decir CONECTADO</p>');
    if (!qrCodeData) return res.send('<html><head><meta http-equiv="refresh" content="2"></head><body><h1>Generando QR TAX VELASCO...</h1><p>Esperando QR... se actualiza solo</p></body></html>');
    try {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<html><body style="text-align:center;background:#111;color:white;font-family:Arial;"><h1 style="color:#25D366;">ESCANEA TAX VELASCO</h1><div style="background:white;padding:20px;display:inline-block;border-radius:20px;"><img src="${qrImage}" style="width:320px;height:320px;"/></div><p>Tambien aparece en tu Google Sheet Configuracion!B2</p><script>setTimeout(()=>location.reload(), 25000);</script></body></html>`);
    } catch(e){ res.send(e.message); }
});

// Endpoint que tu hoja va a llamar cuando le das "Obtener TOKEN Session"
app.post('/iniciarqr', async (req, res) => {
    console.log('Recibido iniciarqr desde hoja:', req.body);
    const { app_script, sheet_id } = req.body;
    if (app_script) {
        sheetToNotify = app_script;
        GOOGLE_SHEET_URL = app_script;
        console.log('Hoja a notificar guardada:', sheetToNotify);
    }
    // Si ya esta conectado, reportar CONECTADO
    if (isConnected && sockInstance) {
        await reportarAHoja('CONECTADO', JSON.stringify(sockInstance.authState?.creds || ''), sockInstance.user?.id || '');
        return res.json({ status: '0', message: 'Bot ya conectado TAX VELASCO' });
    }
    // Si no hay bot corriendo, iniciarlo
    if (!qrCodeData && !isConnected) {
        startBot();
    }
    // Responder que se inicio
    res.json({ status: '0', message: 'Iniciando QR TAX VELASCO, revisa tu hoja Configuracion!B2 en 5 segundos' });
    
    // Esperar 3 seg y forzar reporte si hay QR
    setTimeout(async () => {
        if (qrCodeData) {
            await reportarAHoja(qrCodeData);
        }
    }, 3000);
});

// Endpoint compatible con tu api_interna antigua
app.post('/', async (req, res) => {
    const body = req.body;
    if (body.op === 'iniciarqr') {
        return app._router.handle({ ...req, url: '/iniciarqr', method: 'POST' }, res);
    }
    res.json({ status: '0', message: 'TAX VELASCO API OK' });
});

async function startBot(){
    try {
        // Intentar restaurar sesion si existe archivo
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();
        console.log('Usando WA version', version);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({level: 'silent'}),
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });
        sockInstance = sock;
        sockInstance.authState = state;

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            // Cada vez que se actualizan creds, guardar sesion en hoja
            if (isConnected) {
                try {
                    const credsPath = path.join('auth_info_baileys', 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const credsData = fs.readFileSync(credsPath, 'utf8');
                        await reportarAHoja('CONECTADO', credsData, sock.user?.id || '');
                    }
                } catch(e){ console.log('Error guardando creds en hoja', e.message); }
            }
        });

        sock.ev.on('connection.update', async (update)=>{
            const { connection, lastDisconnect, qr } = update;
            if(qr){
                console.log('NUEVO QR TAX VELASCO GENERADO');
                qrCodeData = qr;
                await reportarAHoja(qr); // <--- Aqui reporta a Configuracion!B2
            }
            if(connection === 'close'){
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log('Conexion cerrada, codigo:', statusCode);
                isConnected = false;
                qrCodeData = null;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if(shouldReconnect){
                    console.log('Reintentando en 5 seg...');
                    setTimeout(startBot, 5000);
                }
            } else if(connection === 'open'){
                console.log('TAX VELASCO CONECTADO CON EXITO');
                isConnected = true;
                qrCodeData = null;
                // Leer creds.json y enviarlo a la hoja como token session
                try {
                    const credsPath = path.join('auth_info_baileys', 'creds.json');
                    const credsData = fs.existsSync(credsPath) ? fs.readFileSync(credsPath, 'utf8') : JSON.stringify(state.creds);
                    const numero = sock.user?.id || '';
                    await reportarAHoja('CONECTADO', credsData, numero);
                } catch(e){ console.log('Error al reportar CONECTADO', e.message); }
            }
        });

        sock.ev.on('messages.upsert', async ({messages})=>{
            for(const msg of messages){
                if(!msg.message || msg.key.fromMe) continue;
                const from = msg.key.remoteJid;
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                console.log('Mensaje:', text);
                // Aqui puedes llamar a tu doPost find_conversacion si quieres bot autoresponder
                if (GOOGLE_SHEET_URL) {
                    try {
                        // Reenviar mensaje a tu hoja para que responda con logica de Conversacion
                        await axios.post(GOOGLE_SHEET_URL, {
                            op: 'find_conversacion',
                            numero: from,
                            mensaje: text
                        });
                    } catch(e){}
                }
            }
        });

    } catch(e){
        console.log('Error fatal startBot', e);
        setTimeout(startBot, 10000);
    }
}

app.listen(PORT, ()=>{ 
    console.log('Servidor TAX VELASCO V4 en puerto '+PORT); 
    startBot(); 
});
