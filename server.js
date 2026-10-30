const express = require('express');
const cors = require('cors');
require('dotenv').config();
const midtransClient = require('midtrans-client');
const isMidtransProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const MAX_PDF_SIZE = 4 * 1024 * 1024;
const MAX_COVER_SIZE = 3 * 1024 * 1024;
const GDRIVE_COVER_SCRIPT_VERSION = 2;

app.use(cors());
app.use(express.json({ limit: '18mb' }));

const GDRIVE_SCRIPT_URL = process.env.GDRIVE_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzDLSShbz7Zpj9SSvmMIMtTYOcX4NzU0zsBtDzpcJlmq3mpFdZKmvoOR_7ndhlG1bzB/exec';
const DEFAULT_GDRIVE_COVER_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz1oLv9WUvooP0e7jJ-2IOyEStCLHMWKicc6ch6p2KssZvI2g59EwPKi9s20YKWdU7s/exec';
const GDRIVE_COVER_SCRIPT_URL = String(process.env.GDRIVE_COVER_SCRIPT_URL || DEFAULT_GDRIVE_COVER_SCRIPT_URL)
    .trim()
    .replace(/\/dev(\?.*)?$/, '/exec');

function extractHtmlErrorHint(htmlText) {
    const text = String(htmlText || '');
    if (/accounts\.google\.com|ServiceLogin/i.test(text)) {
        return 'Akses Apps Script masih terkunci (meminta login Google). Pastikan "Yang memiliki akses" diset ke "Siapa saja".';
    }
    if (/script function not found:\s*doPost/i.test(text)) {
        return 'Fungsi doPost belum ter-deploy di URL /exec aktif. Buka Kelola deployment > Edit (ikon pensil) > pilih Versi baru > Terapkan.';
    }
    if (/Authorization is required|Otorisasi diperlukan/i.test(text)) {
        return 'Izin DriveApp belum diotorisasi di Apps Script. Jalankan fungsi testDanOtorisasiDrive di editor Apps Script terlebih dahulu.';
    }
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch ? `Detail dari Google: ${titleMatch[1].trim()}` : '';
}

// Route pengecekan status server di browser
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Server Backend Nuqthah Learning Center Aktif!'
    });
});

app.get('/api/upload-google-drive', (req, res) => {
    res.json({
        status: 'ready',
        provider: 'GDRIVE',
        uploadMode: 'binary',
        maxFileBytes: MAX_PDF_SIZE
    });
});

app.get('/api/download-google-drive', async (req, res) => {
    const fileId = req.query.fileId;
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(fileId)) {
        return res.status(400).json({ error: 'ID file Google Drive tidak valid.' });
    }

    const fileName = String(req.query.fileName || 'Modul.pdf')
        .replace(/[\\/:*?"<>|\r\n]/g, '_')
        .trim()
        .slice(0, 180) || 'Modul.pdf';
    const pdfFileName = fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`;
    const asciiFileName = pdfFileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    const encodedFileName = encodeURIComponent(pdfFileName).replace(/['()*]/g, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );

    try {
        const driveResponse = await fetch(
            `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`,
            { signal: AbortSignal.timeout(25000) }
        );
        if (!driveResponse.ok || !driveResponse.body) {
            console.error('Google Drive download failed:', driveResponse.status);
            return res.status(502).json({ error: 'Google Drive gagal mengirim file PDF.' });
        }

        const chunks = [];
        let totalBytes = 0;
        const reader = driveResponse.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_PDF_SIZE) {
                await reader.cancel();
                return res.status(413).json({ error: 'PDF melebihi batas download 4 MB.' });
            }
            chunks.push(Buffer.from(value));
        }

        const pdfBuffer = Buffer.concat(chunks, totalBytes);
        if (!pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
            console.error('Google Drive download returned a non-PDF response.');
            return res.status(502).json({ error: 'Google Drive tidak mengirim file PDF yang valid.' });
        }

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': String(pdfBuffer.length),
            'Content-Disposition': `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`,
            'Cache-Control': 'private, no-store'
        });
        return res.send(pdfBuffer);
    } catch (error) {
        console.error('Google Drive download error:', error);
        return res.status(502).json({ error: 'Tidak dapat mengunduh file dari Google Drive.' });
    }
});

app.get('/api/upload-google-drive-cover', async (req, res) => {
    let deploymentId;
    try {
        deploymentId = new URL(GDRIVE_COVER_SCRIPT_URL).pathname.split('/').filter(Boolean).pop();
        const scriptResponse = await fetch(GDRIVE_COVER_SCRIPT_URL, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });
        const responseText = await scriptResponse.text();
        let scriptInfo;
        try {
            scriptInfo = JSON.parse(responseText);
        } catch (error) {
            const hint = extractHtmlErrorHint(responseText);
            return res.status(502).json({
                status: 'error',
                provider: 'GDRIVE',
                deploymentId,
                error: `Apps Script cover aktif membalas HTML, bukan JSON. ${hint}`.trim()
            });
        }

        if (!scriptResponse.ok
            || scriptInfo?.success !== true
            || scriptInfo?.service !== 'Nuqthah course cover uploader'
            || scriptInfo?.version !== GDRIVE_COVER_SCRIPT_VERSION
            || !Number.isFinite(scriptInfo?.maxFileBytes)
            || !Array.isArray(scriptInfo?.acceptedTypes)
            || !['image/jpeg', 'image/png', 'image/webp'].every(type => scriptInfo.acceptedTypes.includes(type))) {
            return res.status(502).json({
                status: 'error',
                provider: 'GDRIVE',
                deploymentId,
                upstreamStatus: scriptResponse.status,
                error: scriptInfo?.error || 'Versi deployment Apps Script cover tidak cocok. Deploy versi terbaru dari project yang berisi doGet dan doPost.'
            });
        }

        return res.json({
            status: 'ready',
            provider: 'GDRIVE',
            deploymentId,
            scriptVersion: scriptInfo.version,
            acceptedTypes: scriptInfo.acceptedTypes,
            maxFileBytes: Math.min(MAX_COVER_SIZE, scriptInfo.maxFileBytes)
        });
    } catch (error) {
        console.error('Google Drive cover health check failed:', error);
        return res.status(502).json({
            status: 'error',
            provider: 'GDRIVE',
            deploymentId,
            error: 'Backend tidak dapat menghubungi Apps Script cover. Periksa URL GDRIVE_COVER_SCRIPT_URL dan koneksi Google.'
        });
    }
});

app.post('/api/upload-google-drive-cover', express.raw({ type: 'image/*', limit: MAX_COVER_SIZE }), async (req, res) => {
    const mimeType = (req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const signatures = {
        'image/jpeg': buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
        'image/png': buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        'image/webp': buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
    };
    if (!Object.hasOwn(signatures, mimeType)) {
        return res.status(400).json({ error: 'Format cover harus JPG, PNG, atau WebP.' });
    }

    let fileName;
    try {
        fileName = decodeURIComponent(req.get('X-File-Name') || '');
    } catch (error) {
        return res.status(400).json({ error: 'Nama file cover tidak valid.' });
    }
    fileName = fileName.replace(/[\\/:*?\"<>|\r\n]/g, '_').trim().slice(0, 180);
    if (!fileName) return res.status(400).json({ error: 'Nama file cover wajib diisi.' });

    const imageBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (imageBuffer.length === 0 || imageBuffer.length > MAX_COVER_SIZE || !signatures[mimeType](imageBuffer)) {
        return res.status(400).json({ error: 'Isi gambar tidak valid atau ukurannya melebihi 3 MB.' });
    }

    try {
        const uploadResponse = await fetch(GDRIVE_COVER_SCRIPT_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
                fileName,
                mimeType,
                base64: imageBuffer.toString('base64')
            })
        });
        const responseText = await uploadResponse.text();
        let uploadResult;
        try {
            uploadResult = JSON.parse(responseText);
        } catch (error) {
            const hint = extractHtmlErrorHint(responseText);
            return res.status(502).json({
                error: `Apps Script cover aktif membalas HTML, bukan JSON. ${hint || 'Deploy versi terbaru dari project cover, set akses ke Siapa saja, lalu gunakan URL deployment /exec yang sama di GDRIVE_COVER_SCRIPT_URL.'}`
            });
        }

        if (!uploadResponse.ok || uploadResult?.success === false || uploadResult?.error) {
            const message = uploadResult?.error || 'Google Drive gagal menyimpan cover.';
            return res.status(502).json({ error: message });
        }

        const file = uploadResult.file || uploadResult.data || uploadResult;
        const fileId = file.fileId || file.id;
        if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(fileId)) {
            return res.status(502).json({ error: 'Google Drive tidak mengembalikan ID file cover yang valid.' });
        }

        return res.json({
            fileId,
            name: typeof file.name === 'string' ? file.name : fileName,
            imageUrl: file.imageUrl || `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`,
            viewUrl: file.viewUrl || `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
        });
    } catch (error) {
        console.error('Google Drive cover upload error:', error);
        return res.status(502).json({ error: 'Tidak dapat menghubungi layanan Google Drive untuk upload cover.' });
    }
});
app.post('/api/upload-google-drive', express.raw({ type: 'application/pdf', limit: MAX_PDF_SIZE }), async (req, res) => {
    if (req.get('X-Upload-Provider') !== 'GDRIVE') {
        return res.status(400).json({ error: 'Konfigurasi penyedia upload tidak valid.' });
    }
    if (req.get('Content-Type') !== 'application/pdf') {
        return res.status(400).json({ error: 'Content-Type harus application/pdf.' });
    }

    let fileName;
    try {
        fileName = decodeURIComponent(req.get('X-File-Name') || '');
    } catch (error) {
        return res.status(400).json({ error: 'Nama file tidak valid.' });
    }
    if (!fileName.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({ error: 'Hanya file PDF yang dapat diunggah.' });
    }

    const fileBuffer = req.body;
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0 || fileBuffer.length > MAX_PDF_SIZE || !fileBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        return res.status(400).json({ error: 'Ukuran atau format file PDF tidak valid (maksimal 4 MB).' });
    }
    const base64 = fileBuffer.toString('base64');

    try {
        const uploadResponse = await fetch(GDRIVE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
                fileName: fileName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180),
                mimeType: 'application/pdf',
                base64
            })
        });
        const responseText = await uploadResponse.text();
        let uploadResult;
        try {
            uploadResult = JSON.parse(responseText);
        } catch (error) {
            console.error('Google Drive upload returned non-JSON response:', error.message);
            return res.status(502).json({ error: 'Google Drive tidak mengembalikan respons upload yang valid.' });
        }

        if (!uploadResponse.ok || uploadResult?.success === false || uploadResult?.error) {
            const message = uploadResult?.error || 'Google Drive gagal menyimpan file.';
            console.error('Google Drive upload failed:', message);
            return res.status(502).json({ error: message });
        }

        const file = uploadResult.file || uploadResult.data || uploadResult;
        const returnedFileUrl = file.webViewLink || file.viewUrl || file.url;
        let urlFileId = null;
        if (typeof returnedFileUrl === 'string') {
            try {
                const returnedUrl = new URL(returnedFileUrl);
                if (returnedUrl.hostname === 'drive.google.com') {
                    urlFileId = returnedUrl.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/)?.[1] || returnedUrl.searchParams.get('id');
                }
            } catch (error) {
                urlFileId = null;
            }
        }
        const fileId = file.fileId || file.id || urlFileId;
        if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(fileId)) {
            console.error('Google Drive upload response is missing a valid file ID.');
            return res.status(502).json({ error: 'Google Drive tidak mengembalikan ID file yang valid.' });
        }

        res.json({
            fileId,
            name: typeof file.name === 'string' ? file.name : fileName,
            viewUrl: `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`,
            downloadUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
        });
    } catch (error) {
        console.error('Google Drive upload error:', error);
        res.status(502).json({ error: 'Tidak dapat menghubungi layanan Google Drive.' });
    }
});

// Inisialisasi Supabase dengan Service Role Key
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Inisialisasi Midtrans Snap API Client
let snap = new midtransClient.Snap({
    isProduction: isMidtransProduction,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Konfigurasi Pengirim Email (Gmail SMTP)
const mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ================= HELPER: PARSE BUNDLING PAKET & METADATA =================
function parseBundleIdsFromLink(rawLink) {
    // Bersihkan akhiran ||META:: terlebih dahulu agar tidak mengganggu pembacaan link/paket
    const str = String(rawLink || '').split('||META::')[0];
    if (!str.startsWith('BUNDLE::')) return [];
    const withoutPrefix = str.substring(8);
    const parts = withoutPrefix.split('||');
    try {
        const ids = JSON.parse(parts[0]);
        return Array.isArray(ids) ? ids : [];
    } catch (e) {
        return [];
    }
}

function parseMidtransExpiryTime(value) {
    if (!value) return null;

    const expiryTime = String(value).trim();
    const normalizedTime = expiryTime.includes('T')
        ? expiryTime
        : expiryTime.replace(' ', 'T');
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalizedTime);
    const parsedTime = new Date(hasTimezone ? normalizedTime : `${normalizedTime}+07:00`);

    return Number.isFinite(parsedTime.getTime()) ? parsedTime : null;
}

function getLearningUrl(courseId) {
    const url = new URL('https://markaz.nuqthahlearning.my.id/halaman_belajar.html');
    url.searchParams.set('course_id', String(courseId));
    return url.toString();
}

// ================= HELPER: NORMALISASI NOMOR & KIRIM WA FONNTE =================
function normalizePhoneNumber(phone) {
    if (!phone) return '';
    let clean = String(phone).replace(/[^0-9]/g, '');

    if (clean.startsWith('00')) {
        clean = clean.substring(2);
    } else if (clean.startsWith('08')) {
        clean = '62' + clean.substring(1);
    } else if (clean.startsWith('8') && clean.length >= 9 && clean.length <= 13) {
        clean = '62' + clean;
    } else if (clean.startsWith('01') && clean.length === 11) {
        clean = '20' + clean.substring(1);
    }
    return clean;
}

async function sendFonnteWhatsApp(targetPhone, messageText) {
    const token = process.env.FONNTE_TOKEN;
    if (!token) {
        console.warn('[FONNTE] FONNTE_TOKEN belum diatur di Environment Variables.');
        return false;
    }

    const formattedPhone = normalizePhoneNumber(targetPhone);
    if (!formattedPhone) {
        console.warn('[FONNTE] Nomor WhatsApp kosong atau tidak valid:', targetPhone);
        return false;
    }

    try {
        const response = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                target: formattedPhone,
                message: messageText,
                countryCode: '0'
            })
        });

        const result = await response.json();
        console.log(`[FONNTE] Respons pengiriman ke ${formattedPhone}:`, result);
        return result;
    } catch (err) {
        console.error('[FONNTE ERROR]:', err.message);
        return false;
    }
}

// ================= HELPER: GRANT ACCESS ANTI-DUPLIKAT =================
async function grantUserAccessSafely({ userId, userEmail, courseId, orderId }) {
    const cleanEmail = (userEmail || '').trim().toLowerCase();
    if (!cleanEmail || !courseId) return;

    // Cek apakah kombinasi user_email + course_id sudah ada di tabel user_access
    const { data: existing } = await supabaseAdmin
        .from('user_access')
        .select('id')
        .eq('user_email', cleanEmail)
        .eq('course_id', courseId)
        .limit(1);

    if (existing && existing.length > 0) {
        // Jika sudah ada, cukup aktifkan tanpa membuat baris baru
        await supabaseAdmin
            .from('user_access')
            .update({ is_active: true, order_id: orderId })
            .eq('id', existing[0].id);
    } else {
        // Jika belum ada, buat 1 baris baru
        await supabaseAdmin
            .from('user_access')
            .insert([{
                user_id: userId || null,
                user_email: cleanEmail,
                course_id: courseId,
                order_id: orderId,
                is_active: true
            }]);
    }
}

// ================= ENDPOINT TRANSAKSI & FOLLOW-UP WA =================

// Endpoint 1: Membuat Transaksi Midtrans & Mengirim WA Follow-Up Pembayaran
app.post('/api/create-transaction', async (req, res) => {
    try {
        const { course_id, price, user_id, user_email } = req.body;
        const orderId = 'NUQTHAH-' + Date.now();
        
        const cleanPrice = parseInt(String(price).replace(/[^0-9]/g, '')) || 10000;

        const { data: userData } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('email', user_email)
            .single();

        const { data: courseData } = await supabaseAdmin
            .from('courses')
            .select('title, link')
            .eq('course_id', course_id)
            .single();

        const studentName = userData?.name || 'Sahabat Nuqthah';
        const studentWa = userData?.whatsapp || '';
        const courseTitle = courseData?.title || course_id;

        // Jangan set expiry global; gunakan masa berlaku default untuk metode yang dipilih di Snap.
        let parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: cleanPrice
            },
            customer_details: {
                first_name: studentName,
                email: user_email || 'student@nuqthah.com',
                phone: studentWa
            },
            callbacks: {
                finish: getLearningUrl(course_id)
            }
        };

        let transaction = await snap.createTransaction(parameter);

        await supabaseAdmin.from('transactions').insert([{
            order_id: orderId,
            user_id: user_id || userData?.id || null,
            user_email: user_email || null,
            course_id: course_id,
            gross_amount: cleanPrice,
            status: 'pending',
            created_at: new Date().toISOString()
            // payment_type dibiarkan null dulu sampai siswa memilih metode bayar di Midtrans
        }]);

        if (studentWa) {
            const formattedRupiah = 'Rp ' + new Intl.NumberFormat('id-ID').format(cleanPrice);
            const learningUrl = getLearningUrl(course_id);

            const followUpMsg = 
`Assalamu'alaikum *${studentName}* 👋

Terima kasih telah melakukan pendaftaran materi di *Nuqthah Learning Center*:
📚 *Materi:* ${courseTitle}
💳 *Total Tagihan:* ${formattedRupiah}
🧾 *ID Pesanan:* ${orderId}

Saat ini status pesanan Anda *Menunggu Pembayaran*. Silakan selesaikan pembayaran melalui jendela pembayaran di layar Anda agar akses penuh video materi dan kuis segera terbuka.

Jika jendela pembayaran tertutup atau Anda ingin melanjutkan nanti, silakan klik tautan berikut:
👉 ${learningUrl}

Apabila ada kendala atau butuh bantuan admin, silakan balas pesan ini. Syukran! 🙏`;

            await sendFonnteWhatsApp(studentWa, followUpMsg);
        }

        res.json({
            token: transaction.token,
            order_id: orderId,
            expires_at: null
        });

    } catch (error) {
        console.error('Midtrans Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pending-transaction', async (req, res) => {
    try {
        const email = String(req.query.email || '').trim().toLowerCase();
        const courseId = String(req.query.course_id || '');

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !courseId || courseId.length > 200) {
            return res.status(400).json({ error: 'Data transaksi tidak valid.' });
        }

        const { data: transactions, error: transactionsError } = await supabaseAdmin
            .from('transactions')
            .select('order_id, user_id, status, payment_type, gross_amount')
            .eq('user_email', email)
            .eq('course_id', courseId)
            .in('status', ['pending', 'success'])
            .order('created_at', { ascending: false })
            .limit(10);

        if (transactionsError) throw transactionsError;

        const grantTransactionAccess = async transaction => {
            const { data: course, error } = await supabaseAdmin
                .from('courses')
                .select('link')
                .eq('course_id', courseId)
                .maybeSingle();
            if (error) throw error;

            const courseIds = Array.from(new Set([
                courseId,
                ...parseBundleIdsFromLink(course?.link)
            ]));
            for (const id of courseIds) {
                await grantUserAccessSafely({
                    userId: transaction.user_id,
                    userEmail: email,
                    courseId: id,
                    orderId: transaction.order_id
                });
            }
        };

        for (const transaction of transactions || []) {
            if (transaction.status === 'success') {
                await grantTransactionAccess(transaction);
                return res.json({ active: false, status: 'success' });
            }

            const midtransStatus = await snap.transaction.status(transaction.order_id);
            const status = midtransStatus.transaction_status;
            const paymentType = midtransStatus.payment_type || transaction.payment_type || null;
            const validExpiry = parseMidtransExpiryTime(midtransStatus.expiry_time);
            const isSuccessful = ['capture', 'settlement'].includes(status) &&
                (midtransStatus.fraud_status === 'accept' || !midtransStatus.fraud_status);

            if (isSuccessful) {
                const { error } = await supabaseAdmin
                    .from('transactions')
                    .update({ status: 'success', payment_type: paymentType })
                    .eq('order_id', transaction.order_id);
                if (error) throw error;

                await grantTransactionAccess(transaction);
                return res.json({ active: false, status: 'success' });
            }

            const isActive = status === 'pending' &&
                Boolean(paymentType) &&
                (!validExpiry || validExpiry.getTime() > Date.now());

            if (isActive) {
                const { error } = await supabaseAdmin
                    .from('transactions')
                    .update({ status: 'pending', payment_type: paymentType })
                    .eq('order_id', transaction.order_id);
                if (error) throw error;

                return res.json({
                    active: true,
                    order_id: transaction.order_id,
                    payment_type: paymentType,
                    gross_amount: transaction.gross_amount,
                    expires_at: validExpiry ? validExpiry.toISOString() : null,
                    server_time: new Date().toISOString()
                });
            }

            if (['cancel', 'deny', 'expire'].includes(status)) {
                const { error } = await supabaseAdmin
                    .from('transactions')
                    .update({ status: 'failed', payment_type: paymentType })
                    .eq('order_id', transaction.order_id);
                if (error) throw error;
            }
        }

        return res.json({ active: false });
    } catch (error) {
        console.error('Gagal memeriksa transaksi aktif akun:', error);
        return res.status(502).json({ error: 'Status pembayaran belum dapat diperiksa.' });
    }
});

app.get('/api/transaction-status/:orderId', async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '');
        const email = String(req.query.email || '').trim().toLowerCase();
        const courseId = String(req.query.course_id || '');

        if (!/^NUQTHAH-\d+$/.test(orderId) || !email || !courseId) {
            return res.status(400).json({ error: 'Data transaksi tidak valid.' });
        }

        const { data: transaction, error: transactionError } = await supabaseAdmin
            .from('transactions')
            .select('order_id, user_email, course_id, status')
            .eq('order_id', orderId)
            .maybeSingle();

        if (transactionError) throw transactionError;
        if (!transaction) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
        if (
            String(transaction.user_email || '').trim().toLowerCase() !== email ||
            transaction.course_id !== courseId
        ) {
            return res.status(403).json({ error: 'Transaksi tidak cocok dengan akun atau materi ini.' });
        }

        if (transaction.status === 'success') {
            return res.json({ active: false, status: 'success', expires_at: null });
        }

        const midtransStatus = await snap.transaction.status(orderId);
        const validExpiry = parseMidtransExpiryTime(midtransStatus.expiry_time);
        const isPending = midtransStatus.transaction_status === 'pending';
        const paymentType = midtransStatus.payment_type || null;
        const isActive = isPending && Boolean(paymentType) && (!validExpiry || validExpiry.getTime() > Date.now());

        if (isPending && paymentType) {
            const { error } = await supabaseAdmin
                .from('transactions')
                .update({ status: 'pending', payment_type: paymentType })
                .eq('order_id', orderId);
            if (error) throw error;
        }

        return res.json({
            active: isActive,
            status: midtransStatus.transaction_status || 'unknown',
            payment_type: paymentType,
            expires_at: validExpiry ? validExpiry.toISOString() : null
        });
    } catch (error) {
        console.error('Gagal memeriksa status transaksi Midtrans:', error);
        return res.status(502).json({ error: 'Status pembayaran belum dapat diperiksa.' });
    }
});

// Endpoint 2: Midtrans Webhook Notification (Anti-Duplikat & Kirim WA Konfirmasi Lunas)
app.post('/api/midtrans-notification', async (req, res) => {
    try {
        let notificationJson = req.body;
        
        let apiClient = new midtransClient.CoreApi({
            isProduction: isMidtransProduction,
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        const statusResponse = await apiClient.transaction.status(notificationJson.order_id);
        
        let orderId = statusResponse.order_id;
        let transactionStatus = statusResponse.transaction_status;
        let fraudStatus = statusResponse.fraud_status;
        let paymentType = statusResponse.payment_type; // <-- Menangkap jenis metode bayar (qris, bank_transfer, dll)

        const { data: trx } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('order_id', orderId)
            .single();

        if (!trx) {
            return res.status(200).json({ status: 'OK', message: 'Transaksi tidak ditemukan di DB' });
        }

        const { data: userData } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('email', trx.user_email)
            .single();

        const { data: courseData } = await supabaseAdmin
            .from('courses')
            .select('title, link')
            .eq('course_id', trx.course_id)
            .single();

        const studentName = userData?.name || 'Sahabat Nuqthah';
        const studentWa = userData?.whatsapp || '';
        const courseTitle = courseData?.title || trx.course_id;
        const learningUrl = getLearningUrl(trx.course_id);

        if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
            if (fraudStatus == 'accept' || !fraudStatus) {
                const wasAlreadySuccess = trx.status === 'success';

                // === PERUBAHAN DI SINI: SIMPAN payment_type ===
                await supabaseAdmin
                    .from('transactions')
                    .update({ 
                        status: 'success',
                        payment_type: paymentType 
                    })
                    .eq('order_id', orderId);

                const bundledIds = parseBundleIdsFromLink(courseData?.link);
                const allCourseIdsToGrant = Array.from(new Set([trx.course_id, ...bundledIds]));

                // Buka akses untuk materi utama maupun seluruh materi di dalam Paket Bundling
                for (const cid of allCourseIdsToGrant) {
                    await grantUserAccessSafely({
                        userId: trx.user_id || userData?.id || null,
                        userEmail: trx.user_email,
                        courseId: cid,
                        orderId: orderId
                    });
                }

                if (!wasAlreadySuccess && studentWa) {
                    const formattedRupiah = 'Rp ' + new Intl.NumberFormat('id-ID').format(trx.gross_amount || 0);
                    const successMsg = 
`Alhamdulillah! Assalamu'alaikum *${studentName}* 🎉

Pembayaran Anda telah *BERHASIL* kami terima:
📚 *Materi:* ${courseTitle}
💳 *Total Dibayar:* ${formattedRupiah}
🧾 *ID Pesanan:* ${orderId}
✅ *Status:* LUNAS (Akses Penuh Terbuka)

Seluruh sesi video pembelajaran dan kuis interaktif kini telah aktif untuk akun Anda (${trx.user_email}).

Silakan mulai belajar melalui tautan berikut:
👉 ${learningUrl}

*(Tips: Jika Anda ingin membuka materi di perangkat atau HP lain, cukup klik tombol "Masuk Akun" di pojok kanan atas dan masukkan email Anda untuk menerima kode OTP).*

Selamat belajar, semoga ilmunya bermanfaat dan berkah! 🌟
*#MumtazBarengNuqthah*`;

                    await sendFonnteWhatsApp(studentWa, successMsg);
                }
            }
        } else if (transactionStatus == 'pending') {
            if (trx.status !== 'success') {
                const { error } = await supabaseAdmin
                    .from('transactions')
                    .update({
                        status: 'pending',
                        payment_type: paymentType
                    })
                    .eq('order_id', orderId);
                if (error) throw error;
            }
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            const wasAlreadyFailed = trx.status === 'failed';

            // === PERUBAHAN DI SINI: SIMPAN payment_type (opsional untuk transaksi gagal) ===
            await supabaseAdmin
                .from('transactions')
                .update({ 
                    status: 'failed',
                    payment_type: paymentType
                })
                .eq('order_id', orderId);

            if (transactionStatus == 'expire' && !wasAlreadyFailed && studentWa) {
                const expireMsg = 
`Assalamu'alaikum *${studentName}*,

Batas waktu pembayaran untuk pesanan *${orderId}* pada materi *${courseTitle}* telah berakhir (kedaluwarsa).

Apabila Anda masih ingin membuka akses penuh materi ini, silakan lakukan pemesanan ulang melalui halaman ruang belajar berikut:
👉 ${learningUrl}

Jika Anda mengalami kesulitan saat melakukan pembayaran, silakan balas pesan ini untuk dibantu oleh admin kami. Syukran! 🙏`;

                await sendFonnteWhatsApp(studentWa, expireMsg);
            }
        }

        res.status(200).json({ status: 'OK' });
    } catch (error) {
        console.error('Notification Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ================= ROUTE AUTENTIKASI & OTP (MULTI-DEVICE) =================

app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, error: 'Email wajib diisi.' });
    }

    try {
        const { data: userExist, error: uErr } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (uErr || !userExist) {
            return res.status(404).json({
                success: false,
                error: 'Email belum terdaftar. Silakan lakukan pendaftaran melalui tombol Buka Akses Penuh.'
            });
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        const { error: otpErr } = await supabaseAdmin
            .from('otps')
            .insert([{ email, code: otpCode, expires_at: expiresAt, used: false }]);

        if (otpErr) throw otpErr;

        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            await mailTransporter.sendMail({
                from: `"Nuqthah Learning Center" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `${otpCode} adalah Kode Masuk OTP Nuqthah Learning Anda`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 16px;">
                        <h2 style="color: #234B36; margin-top: 0;">Nuqthah Learning Center</h2>
                        <p style="color: #374151; font-size: 14px;">Assalamu'alaikum <strong>${userExist.name}</strong>,</p>
                        <p style="color: #374151; font-size: 14px;">Berikut adalah kode OTP untuk masuk dan membuka akses materi pembelajaran Anda:</p>
                        <div style="background-color: #f3f4f6; padding: 16px; border-radius: 12px; text-align: center; margin: 20px 0;">
                            <span style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #234B36;">${otpCode}</span>
                        </div>
                        <p style="color: #6b7280; font-size: 12px;">Kode ini berlaku selama 10 menit. Jangan berikan kode ini kepada siapa pun.</p>
                    </div>
                `
            });
        }

        if (userExist.whatsapp && process.env.FONNTE_TOKEN) {
            const otpWaMsg = 
`Assalamu'alaikum *${userExist.name}*,

Kode OTP untuk masuk ke akun belajar *Nuqthah Learning Center* Anda adalah:
*${otpCode}*

Kode ini berlaku selama 10 menit. Jangan berikan kode ini kepada siapa pun.`;
            await sendFonnteWhatsApp(userExist.whatsapp, otpWaMsg);
        }

        res.json({ success: true, message: 'Kode OTP berhasil dikirim.' });
    } catch (err) {
        console.error('Error send-otp:', err);
        res.status(500).json({ success: false, error: 'Gagal mengirim kode OTP: ' + err.message });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
        return res.status(400).json({ success: false, error: 'Email dan kode OTP wajib diisi.' });
    }

    try {
        const { data: otpData, error: oErr } = await supabaseAdmin
            .from('otps')
            .select('*')
            .eq('email', email)
            .eq('code', code)
            .eq('used', false)
            .order('expires_at', { ascending: false })
            .limit(1)
            .single();

        if (oErr || !otpData || new Date(otpData.expires_at) < new Date()) {
            return res.status(400).json({ success: false, error: 'Kode OTP salah atau sudah kedaluwarsa.' });
        }

        await supabaseAdmin
            .from('otps')
            .update({ used: true })
            .eq('id', otpData.id);

        const { data: userData, error: uErr } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (uErr || !userData) {
            return res.status(404).json({ success: false, error: 'Data pengguna tidak ditemukan.' });
        }

        res.json({ success: true, user: userData });
    } catch (err) {
        console.error('Error verify-otp:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;

app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
        const isCoverUpload = req.path === '/api/upload-google-drive-cover';
        return res.status(413).json({
            error: isCoverUpload ? 'Ukuran gambar cover maksimal 3 MB.' : 'PDF melebihi batas upload 4 MB.'
        });
    }
    next(error);
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server Nuqthah berjalan di port ${PORT}`);
    });
}

module.exports = app;
