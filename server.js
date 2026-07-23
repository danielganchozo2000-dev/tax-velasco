const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const axios = require('axios');
const P = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
let GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || 'https://script.google.com/macros/s/AKfycbx7BQTSU3yIwItZnKfKepL-IgWzmDnPHBxI4iVCJU9Yn0W4WX-zmugptwZBMoJSW4NH/exec';
let sheetToNotify = null;

let qrCodeData = null;
let isConnected = false;
let sockInstance = null;

console.log('TAX VELASCO V4.2 - FINAL con tu hoja');

async function reportarAHoja(qr, session = '', numero = '') {
    const targetUrl = sheetToNotify || GOOGLE_SHEET_URL;
    if (!targetUrl) { console.log('Sin GOOGLE_SHEET_URL'); return; }
    if (targetUrl.includes('AKfycbz8')) { console.log('URL vieja Anlusoft detectada'); return; }
    try {
        console.log('Reportando a hoja: ' + targetUrl.substring(0,60) + '...');
        await axios.post(targetUrl, { op: 'qr', qr: qr, session: session, numero: numero }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
        console.log('Reporte OK a hoja');
    } catch (e) {
        console.log('Error reporte hoja: ' + (e.response?.status || e.message));
    }
}

app.get('/', (req,res)=> res.send(`<h1>TAX VELASCO V4.2 ONLINE</h1><p>Estado: ${isConnected?'CONECTADO':'QR esperando'}</p><a href="/qr">VER QR</a>`));

app.get('/qr', async (req,res)=>{
    if (isConnected) return res.send('<h1>YA CONECTADO - revisa tu hoja B2</h1>');
    if (!qrCodeData) return res.send('<html><head><meta http-equiv="refresh" content="2"></head><body><h1>Generando QR TAX VELASCO...</h1></body></html>');
    try {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<html><body style="text-align:center;background:#111;color:white;"><h1>ESCANEA TAX VELASCO</h1><div style="background:white;padding:20px;display:inline-block;border-radius:20px;"><img src="${qrImage}" style="width:320px;height:320px;"/></div><script>setTimeout(()=>location.reload(),20000);</script></body></html>`);
    } catch(e){ res.send(e.message); }
});

app.post('/iniciarqr', async (req,res)=>{
    console.log('iniciarqr recibido', req.body);
    if (req.body.app_script) { sheetToNotify = req.body.app_script; GOOGLE_SHEET_URL = req.body.app_script; }
    if (isConnected) { await reportarAHoja('CONECTADO','ya_conectado',sockInstance?.user?.id||''); return res.json({status:'0', message:'Ya conectado'}); }
    if (!qrCodeData && !isConnected) startBot();
    res.json({status:'0', message:'Iniciando QR revisa B2'});
    setTimeout(()=>{ if(qrCodeData) reportarAHoja(qrCodeData); }, 3000);
});

app.post('/', async (req,res)=>{
    if (req.body.op === 'iniciarqr') { req.url='/iniciarqr'; return app.handle(req,res); }
    res.json({status:'0'});
});

async function startBot(){
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();
        console.log('WA version', version);
        const sock = makeWASocket({ version, auth: state, logger: P({level:'silent'}), browser: Browsers.macOS('Desktop'), syncFullHistory:false, markOnlineOnConnect:false });
        sockInstance = sock;
        sock.ev.on('creds.update', async ()=>{
            await saveCreds();
            if (isConnected) {
                try {
                    const p = path.join('auth_info_baileys','creds.json');
                    if (fs.existsSync(p)) { const data = fs.readFileSync(p,'utf8'); await reportarAHoja('CONECTADO', data, sock.user?.id||''); }
                } catch(e){}
            }
        });
        sock.ev.on('connection.update', async (update)=>{
            const { connection, lastDisconnect, qr } = update;
            if (qr) { console.log('NUEVO QR GENERADO'); qrCodeData = qr; await reportarAHoja(qr); }
            if (connection==='close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const msg = lastDisconnect?.error?.message || '';
                console.log('Cerrada codigo:'+code+' msg:'+msg);
                isConnected = false; qrCodeData = null;
                const isConflict = String(msg).toLowerCase().includes('conflict');
                const isLoggedOut = code===DisconnectReason.loggedOut && !isConflict;
                if (!isLoggedOut) { console.log('Reintentando 5s'); setTimeout(startBot,5000); }
            } else if (connection==='open') {
                console.log('TAX VELASCO CONECTADO CON EXITO');
                isConnected = true; qrCodeData = null;
                try {
                    const p = path.join('auth_info_baileys','creds.json');
                    const data = fs.existsSync(p) ? fs.readFileSync(p,'utf8') : JSON.stringify(state.creds);
                    await reportarAHoja('CONECTADO', data, sock.user?.id||'');
                } catch(e){}
            }
        });
        sock.ev.on('messages.upsert', async ({messages})=>{ for(const m of messages){ if(!m.message||m.key.fromMe) continue; console.log('Mensaje', m.message.conversation||''); } });
    } catch(e){ console.log('Error startBot', e); setTimeout(startBot,10000); }
}

app.listen(PORT, ()=>{ console.log('V4.2 puerto '+PORT); startBot(); });
