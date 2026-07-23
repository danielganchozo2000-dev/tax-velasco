const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const axios = require('axios');
const P = require('pino');

const app = express();
const PORT = process.env.PORT || 10000;
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || '';

let qrCodeData = null;
let isConnected = false;
let lastQRTime = 0;

app.get('/', (req, res) => {
    res.send(`<h1 style="font-family: Arial; text-align:center; margin-top:50px;">TAX VELASCO ONLINE</h1><p style="text-align:center;">Estado: ${isConnected ? 'CONECTADO' : 'Esperando QR - ve a /qr'}</p><a href="/qr" style="display:block;text-align:center;font-size:20px;">VER QR</a>`);
});

app.get('/qr', async (req, res) => {
    if (isConnected) return res.send('<h1>YA CONECTADO TAX VELASCO</h1>');
    if (!qrCodeData) {
        return res.send(`<html><head><meta http-equiv="refresh" content="2"></head><body style="text-align:center;font-family:Arial;"><h1>Generando QR TAX VELASCO...</h1><p>Generando... ${new Date().toLocaleTimeString()} - se actualiza solo cada 2 seg</p></body></html>`);
    }
    try {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`<html><body style="text-align:center;background:#111;color:white;font-family:Arial;"><h1 style="color:#25D366;">ESCANEA TAX VELASCO</h1><div style="background:white;padding:20px;display:inline-block;border-radius:20px;"><img src="${qrImage}" style="width:320px;height:320px;" /></div><p>WhatsApp > Dispositivos vinculados > Vincular</p><script>setTimeout(()=>location.reload(), 25000);</script></body></html>`);
    } catch(e){ res.send(e.message); }
});

async function startBot(){
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();
        console.log('Usando WA version', version, 'para TAX VELASCO');

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({level: 'silent'}),
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            retryRequestDelayMs: 2000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update)=>{
            const { connection, lastDisconnect, qr } = update;
            if(qr){
                console.log('NUEVO QR TAX VELASCO GENERADO');
                qrCodeData = qr;
                lastQRTime = Date.now();
            }
            if(connection === 'close'){
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log('Conexion cerrada, codigo:', statusCode, lastDisconnect?.error?.message);
                isConnected = false;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;
                if(shouldReconnect){
                    console.log('Reintentando en 5 seg...');
                    setTimeout(startBot, 5000);
                } else {
                    console.log('Sesion cerrada, borrando auth');
                }
            } else if(connection === 'open'){
                console.log('TAX VELASCO CONECTADO CON EXITO');
                isConnected = true;
                qrCodeData = null;
            }
        });

        sock.ev.on('messages.upsert', async ({messages})=>{
            for(const msg of messages){
                if(!msg.message || msg.key.fromMe) continue;
                const from = msg.key.remoteJid;
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                if(text.toLowerCase().includes('hola')){
                    await sock.sendMessage(from, {text: 'Hola! Soy *TAX VELASCO* - Bot Oficial listo!'});
                }
            }
        });

    } catch(e){
        console.log('Error fatal startBot', e);
        setTimeout(startBot, 10000);
    }
}

app.listen(PORT, ()=>{ console.log('Servidor TAX VELASCO en puerto '+PORT); startBot(); });
