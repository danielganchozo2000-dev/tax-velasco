const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || 'https://script.google.com/macros/s/AKfycbx09JJosvZk6x8koLPL5Y4u8mqe4pGo0KudMHXtDJXCjsBNHofJZ0ZqJ0PV-c8g/exec';

let qrCodeData = null;
let isConnected = false;
let sock = null;

app.get('/', (req, res) => {
    res.send(`
        <h1 style="font-family: Arial; text-align:center; margin-top:50px;">🔥 TAX VELASCO BOT ONLINE 🔥</h1>
        <p style="text-align:center;">Estado: ${isConnected ? '✅ CONECTADO' : '⏳ Esperando QR'}</p>
        <p style="text-align:center;"><a href="/qr" style="font-size:20px; background:#25D366; color:white; padding:15px 30px; text-decoration:none; border-radius:10px;">VER QR AQUÍ</a></p>
    `);
});

app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send('<h1>✅ TAX VELASCO YA ESTÁ CONECTADO</h1><p>No necesitas escanear de nuevo.</p>');
    }
    if (!qrCodeData) {
        return res.send(`
            <html>
            <head><meta http-equiv="refresh" content="3"></head>
            <body style="text-align:center; font-family:Arial; margin-top:50px;">
                <h1>⏳ Generando QR TAX VELASCO...</h1>
                <p>Espera 5 segundos, se actualiza solo.</p>
                <p>Si tarda, mira los Logs en Render.</p>
            </body>
            </html>
        `);
    }
    try {
        const qrImage = await QRCode.toDataURL(qrCodeData);
        res.send(`
            <html>
            <body style="text-align:center; font-family:Arial; background:#111; color:white;">
                <h1 style="color:#25D366;">📲 ESCANEA - TAX VELASCO</h1>
                <div style="background:white; padding:20px; display:inline-block; border-radius:20px;">
                    <img src="${qrImage}" style="width:300px; height:300px;" />
                </div>
                <p>Abre WhatsApp > Dispositivos vinculados > Vincular dispositivo</p>
                <p style="color:yellow;">Este QR se actualiza cada 30 segundos. Si no funciona, recarga la página.</p>
                <script>setTimeout(()=>location.reload(), 30000);</script>
            </body>
            </html>
        `);
    } catch (e) {
        res.send('Error generando QR: ' + e.message);
    }
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        // NO usamos printQRInTerminal, por eso se quitó el error
        browser: ['TAX VELASCO', 'Chrome', '1.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Generado para TAX VELASCO');
            qrCodeData = qr;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Desconectado. Reconectando:', shouldReconnect);
            isConnected = false;
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ TAX VELASCO CONECTADO CON ÉXITO');
            isConnected = true;
            qrCodeData = null;
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                const from = msg.key.remoteJid;
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                console.log('Mensaje:', text);

                // Aquí tu lógica de impuestos - guarda en Google Sheet
                if (GOOGLE_SHEET_URL && text) {
                    try {
                        await axios.post(GOOGLE_SHEET_URL, {
                            numero: from,
                            mensaje: text,
                            fecha: new Date().toISOString()
                        });
                    } catch (e) {
                        console.log('Error Sheet:', e.message);
                    }
                }

                // Respuesta de ejemplo TAX VELASCO
                if (text.toLowerCase().includes('hola')) {
                    await sock.sendMessage(from, { text: '¡Hola! 👋 Soy el Bot Oficial de *TAX VELASCO* 🧾💼\n\nEnvíame tu factura o escribe *AYUDA* para ver mis servicios.' });
                }
            }
        } catch (e) {
            console.log('Error mensaje:', e);
        }
    });
}

app.listen(PORT, () => {
    console.log(`Servidor TAX VELASCO corriendo en puerto ${PORT}`);
    startBot();
});
