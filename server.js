
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const QRCode = require('qrcode');
const P = require('pino');

const app = express();
app.use(express.json({limit: '50mb'}));

const PORT = process.env.PORT || 3000;

// TU GOOGLE SHEET - CAMBIALO AQUI
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || ""; // Pega tu URL de Apps Script aqui
const NOMBRE_BOT = "TAX VELASCO";

let qrActual = "";
let estado = "DESCONECTADO";
let sockGlobal = null;

async function conectarWhatsApp(){
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    logger: P({level: 'silent'}),
    browser: [NOMBRE_BOT, "Chrome", "1.0"],
    printQRInTerminal: true
  });
  sockGlobal = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if(qr){
      qrActual = qr;
      estado = "QR_GENERADO";
      console.log("QR generado para TAX VELASCO");
      // Enviar QR a Google Sheet
      if(GOOGLE_SHEET_URL){
        try{
          await axios.post(GOOGLE_SHEET_URL, {op:"qr", qr: qr, session: "TAX_VELASCO_SESSION"});
        }catch(e){}
      }
    }
    if(connection === 'close'){
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      estado = "DESCONECTADO";
      console.log("Desconectado, reconectando:", shouldReconnect);
      if(shouldReconnect) conectarWhatsApp();
    } else if(connection === 'open'){
      estado = "CONECTADO";
      qrActual = "CONECTADO";
      console.log("TAX VELASCO CONECTADO ✅");
      if(GOOGLE_SHEET_URL){
        try{
          await axios.post(GOOGLE_SHEET_URL, {op:"qr", qr: "CONECTADO", session: "TAX_VELASCO_PERMANENTE_" + Date.now()});
        }catch(e){}
      }
    }
  });

  // RECIBIR MENSAJES DE CLIENTES
  sock.ev.on('messages.upsert', async (m) => {
    try{
      const msg = m.messages[0];
      if(!msg.message || msg.key.fromMe) return;
      const numero = msg.key.remoteJid;
      const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      const esUbicacion = msg.message.locationMessage ? true : false;
      
      let documento = {};
      if(esUbicacion){
        documento = {latitud: msg.message.locationMessage.degreesLatitude, longitud: msg.message.locationMessage.degreesLongitude};
      }

      // Enviar a Google Sheet para que tu bot V5 responda
      if(GOOGLE_SHEET_URL){
        const payload = {
          op: "find_conversacion",
          numero: numero,
          mensaje: esUbicacion ? "ubicacion_send" : texto,
          documento: documento
        };
        try{
          const resp = await axios.post(GOOGLE_SHEET_URL, payload);
          const data = resp.data;
          if(data && data.mensaje_salida){
            await sock.sendMessage(numero, {text: data.mensaje_salida});
            // Si hay reenvio al grupo
            if(data.reenviar && data.numeroreenviar){
              const grupoId = data.numeroreenviar.includes('@g.us') ? data.numeroreenviar : data.numeroreenviar + '@g.us';
              await sock.sendMessage(grupoId, {text: data.reenviar});
            }
            // Si hay array de mensajes
            if(data.mensajes && Array.isArray(data.mensajes)){
              for(let mm of data.mensajes){
                if(mm.mensaje_salida) await sock.sendMessage(numero, {text: mm.mensaje_salida});
              }
            }
          }
        }catch(e){ console.log("Error Google Sheet:", e.message); }
      }
    }catch(e){ console.log(e); }
  });
}

// API PARA TU SHEET
app.get('/', (req,res)=>{ res.send(`<h1>${NOMBRE_BOT} SERVER PROPIO ✅</h1><p>Estado: ${estado}</p><p><a href='/qr'>Ver QR</a></p>`); });

app.get('/qr', async (req,res)=>{
  if(estado === "CONECTADO") return res.send("<h1>TAX VELASCO CONECTADO ✅</h1><p>Sesión activa (TAX VELASCO)</p>");
  if(!qrActual) return res.send("<h1>Generando QR...</h1><script>setTimeout(()=>location.reload(),2000)</script>");
  try{
    const qrImg = await QRCode.toDataURL(qrActual);
    res.send(`<h1>TAX VELASCO - Escanea este QR</h1><img src='${qrImg}' width='350'/><p>Estado: ${estado}</p><p>Sesión: TAX VELASCO (Propio, no Anlusoft)</p><script>setTimeout(()=>location.reload(),20000)</script>`);
  }catch(e){ res.send("Error QR"); }
});

app.post('/iniciarqr', (req,res)=>{
  res.json({status:'0', qr: qrActual, estado: estado});
});

app.post('/sendmessagewk', (req,res)=>{
  // Compatible con tu Apps Script viejo
  res.json({status:'0'});
});

app.listen(PORT, ()=>{ console.log(`Servidor ${NOMBRE_BOT} en puerto ${PORT}`); conectarWhatsApp(); });
