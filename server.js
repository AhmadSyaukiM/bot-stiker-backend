const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadContentFromMessage,
    Browsers
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const sharp = require('sharp');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

let sock = null;
let qrCodeData = null;
let isConnected = false;
let isInitializing = false;

async function startBaileys() {
    if (isConnected) return;
    
    isInitializing = true;
    qrCodeData = null;
    io.emit('qr_status', { qr: null, isConnected: false, isInitializing: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');

        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end(undefined);
            } catch (e) {
                console.error('Clean socket error:', e);
            }
            sock = null;
        }

        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            // PERBAIKAN: Gunakan identitas browser resmi bawaan Baileys
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeData = await QRCode.toDataURL(qr);
                isConnected = false;
                isInitializing = false;
                console.log('QR Code generated successfully');
                io.emit('qr_status', { qr: qrCodeData, isConnected: false, isInitializing: false });
            }

            if (connection === 'open') {
                qrCodeData = null;
                isConnected = true;
                isInitializing = false;
                io.emit('qr_status', { qr: null, isConnected: true, isInitializing: false });
                console.log('Bot WA Web Bridge Siap!');
            }

            if (connection === 'close') {
                isConnected = false;
                isInitializing = false;
                qrCodeData = null;
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`Koneksi terputus dengan status code: ${statusCode}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    try {
                        fs.rmSync('auth_info', { recursive: true, force: true });
                    } catch (err) {
                        console.error('Gagal hapus folder auth_info:', err);
                    }
                }

                io.emit('qr_status', { qr: null, isConnected: false, isInitializing: false });

                if (sock) {
                    sock.ev.removeAllListeners();
                    sock.end(undefined);
                    sock = null;
                }

                if (shouldReconnect) {
                    setTimeout(() => startBaileys(), 3000);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                const imageMessage = msg.message?.imageMessage;

                if (imageMessage) {
                    const from = msg.key.remoteJid;
                    try {
                        const stream = await downloadContentFromMessage(imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }

                        const processedBuffer = await sharp(buffer)
                            .resize(512, 512, {
                                fit: 'contain',
                                background: { r: 0, g: 0, b: 0, alpha: 0 }
                            })
                            .webp()
                            .toBuffer();

                        await sock.sendMessage(from, { sticker: processedBuffer }, { quoted: msg });
                    } catch (err) {
                        console.error('Gagal buat stiker:', err);
                    }
                }
            }
        });
    } catch (error) {
        console.error('Gagal inisialisasi Baileys:', error);
        isInitializing = false;
        io.emit('qr_status', { qr: null, isConnected: false, isInitializing: false });
    }
}

app.get('/api/status', (req, res) => {
    res.json({ qr: qrCodeData, isConnected, isInitializing });
});

app.post('/api/generate-qr', async (req, res) => {
    try {
        if (!isConnected) {
            isInitializing = false;
            startBaileys();
        }
        res.json({ success: true, qr: qrCodeData, isConnected, isInitializing });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        qrCodeData = null;
        isConnected = false;
        isInitializing = false;

        if (sock) {
            try {
                await sock.logout();
            } catch (e) {
                console.error('Logout error:', e);
            }
            sock.ev.removeAllListeners();
            sock.end(undefined);
            sock = null;
        }

        try {
            fs.rmSync('auth_info', { recursive: true, force: true });
        } catch (e) {
            console.error('Error hapus auth_info:', e);
        }

        io.emit('qr_status', { qr: null, isConnected: false, isInitializing: false });
        res.json({ success: true, message: 'Berhasil disconnect dari WA!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

io.on('connection', (socket) => {
    socket.emit('qr_status', { qr: qrCodeData, isConnected, isInitializing });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Backend Server berjalan di port ${PORT}`);
});