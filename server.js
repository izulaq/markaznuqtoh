const express = require('express');
const cors = require('cors');
require('dotenv').config();
const crypto = require('crypto');
const midtransClient = require('midtrans-client');
const isMidtransProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const MAX_PDF_SIZE = 4 * 1024 * 1024;
const MAX_COVER_SIZE = 3 * 1024 * 1024;
const GDRIVE_COVER_SCRIPT_VERSION = 2;
const OTP_TTL_MS = 60 * 1000;
const KITAB_COURSE_ID = 'nlc-syamilah-pro';
const KITAB_SUBSCRIPTION_PRICE = 35000;
const AI_REQUEST_TIMEOUT_MS = 55000;
const KITAB_FOCUS_OPTIONS = new Set([
    'Semua Mazhab',
    "Fiqih Syafi'i",
    'Fiqih Hanafi',
    'Fiqih Maliki',
    'Fiqih Hambali',
    'Aqidah/Tauhid',
    'Hadits'
]);

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

async function getPurchasedWhatsAppGroupLinks(courseId, courseData) {
    const rawLink = String(courseData?.link || '');
    const isBundle = rawLink.startsWith('BUNDLE::');
    const courseIds = Array.from(new Set((isBundle
        ? parseBundleIdsFromLink(rawLink)
        : [courseId]
    ).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())));
    if (courseIds.length === 0) return [];

    const { data: courses, error: courseError } = await supabaseAdmin
        .from('courses')
        .select('course_id, title')
        .in('course_id', courseIds);
    if (courseError) throw courseError;
    const { data: groups, error: groupError } = await supabaseAdmin
        .from('course_whatsapp_groups')
        .select('course_id, whatsapp_group_link')
        .in('course_id', courseIds);
    if (groupError) throw groupError;

    const coursesById = new Map((courses || []).map(course => [course.course_id, course]));
    const groupLinksByCourseId = new Map((groups || []).map(group => [group.course_id, group.whatsapp_group_link]));
    return courseIds.flatMap(id => {
        const course = coursesById.get(id);
        const url = String(groupLinksByCourseId.get(id) || '').trim();
        if (!url || !course) return [];
        return [{ title: course.title || id, url }];
    });
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
    if (!cleanEmail || !courseId) return false;

    const { data: existing, error: existingError } = await supabaseAdmin
        .from('user_access')
        .select('id, is_active')
        .eq('user_email', cleanEmail)
        .eq('course_id', courseId)
        .limit(1)
        .maybeSingle();

    if (existingError) throw existingError;
    if (existing) return existing.is_active === true;

    const { error: insertError } = await supabaseAdmin
        .from('user_access')
        .insert([{
            user_id: userId || null,
            user_email: cleanEmail,
            course_id: courseId,
            order_id: orderId,
            is_active: true
        }]);

    if (insertError) throw insertError;
    return true;
}

async function grantTransactionAccessSafely({ userId, userEmail, courseId, orderId }) {
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
        await grantUserAccessSafely({ userId, userEmail, courseId: id, orderId });
    }

    const { data: activeAccess, error: accessError } = await supabaseAdmin
        .from('user_access')
        .select('id')
        .eq('user_email', String(userEmail || '').trim().toLowerCase())
        .eq('course_id', courseId)
        .eq('is_active', true)
        .limit(1);
    if (accessError) throw accessError;
    return Boolean(activeAccess?.length);
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function createOtpSessionToken(email, userId) {
    const secret = process.env.OTP_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secret) throw new Error('Rahasia sesi OTP belum dikonfigurasi.');

    const payload = Buffer.from(JSON.stringify({
        email,
        userId: userId || null,
        expiresAt: Date.now() + (12 * 60 * 60 * 1000)
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function getAuthenticatedOtpSession(req, expectedEmail) {
    const secret = process.env.OTP_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const authorization = String(req.get('authorization') || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!secret || !token || token.length > 2048) return null;

    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest();
    let suppliedSignature;
    try {
        suppliedSignature = Buffer.from(signature, 'base64url');
    } catch (error) {
        return null;
    }
    if (
        suppliedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
    ) return null;

    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (
            !session.email ||
            session.email !== expectedEmail ||
            !Number.isFinite(session.expiresAt) ||
            session.expiresAt <= Date.now()
        ) return null;
        return session;
    } catch (error) {
        return null;
    }
}

async function hasKitabSubscription(email) {
    const { data, error } = await supabaseAdmin
        .from('user_access')
        .select('id')
        .eq('user_email', email)
        .eq('course_id', KITAB_COURSE_ID)
        .eq('is_active', true)
        .limit(1);
    if (error) throw error;
    return Boolean(data?.length);
}

async function requireKitabSubscription(req, res, email) {
    if (!getAuthenticatedOtpSession(req, email)) {
        res.status(401).json({ error: 'Sesi login tidak valid atau kedaluwarsa. Silakan masuk kembali.' });
        return false;
    }
    if (!await hasKitabSubscription(email)) {
        res.status(403).json({
            error: 'Langganan Pencarian Referensi Kitab AI belum aktif.',
            requires_subscription: true,
            course_id: KITAB_COURSE_ID
        });
        return false;
    }
    return true;
}

async function callAiChatCompletion(messages) {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
        .trim()
        .replace(/\/+$/, '');
    const model = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

    if (apiKey) {
        const endpoint = /\/chat\/completions$/i.test(baseUrl)
            ? baseUrl
            : `${baseUrl}/chat/completions`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                temperature: 0.2,
                reasoning_effort: 'low',
                max_tokens: 900,
                response_format: { type: 'json_object' },
                messages
            }),
            signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error('AI provider returned an error:', response.status, result?.error?.message || '');
            throw new Error('Layanan AI sedang tidak dapat memproses pencarian.');
        }
        const content = result?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('Layanan AI tidak mengembalikan jawaban yang dapat dibaca.');
        }
        return content;
    }

    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!geminiKey) throw new Error('Layanan AI belum dikonfigurasi pada server.');
    const geminiModel = String(process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim();
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: messages[0].content }] },
                contents: [{ role: 'user', parts: [{ text: messages[1].content }] }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 900,
                    responseMimeType: 'application/json'
                }
            }),
            signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
        }
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.error('Gemini provider returned an error:', response.status, result?.error?.message || '');
        throw new Error('Layanan AI sedang tidak dapat memproses pencarian.');
    }
    const content = result?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim();
    if (!content) throw new Error('Layanan AI tidak mengembalikan jawaban yang dapat dibaca.');
    return content;
}

function parseKitabAiResponse(content) {
    const normalizedContent = String(content || '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    const result = JSON.parse(normalizedContent);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Format jawaban AI tidak valid.');
    }

    const asText = (value, maxLength = 5000) =>
        typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
    const references = Array.isArray(result.references) ? result.references.slice(0, 3).map(reference => {
        const rawSourceUrl = asText(reference?.source_url, 500);
        let sourceUrl = null;
        try {
            const parsedUrl = new URL(rawSourceUrl);
            if (
                parsedUrl.protocol === 'https:' &&
                (parsedUrl.hostname === 'shamela.ws' || parsedUrl.hostname.endsWith('.shamela.ws'))
            ) sourceUrl = parsedUrl.toString();
        } catch (error) {
            sourceUrl = null;
        }

        return {
            book_title: asText(reference?.book_title, 300),
            author: asText(reference?.author, 200),
            author_death: asText(reference?.author_death, 100),
            madhhab: asText(reference?.madhhab, 120),
            volume: asText(reference?.volume, 50),
            page: asText(reference?.page, 50),
            arabic_text: asText(reference?.arabic_text, 5000),
            translation: asText(reference?.translation, 5000),
            explanation: asText(reference?.explanation, 3000),
            source_url: sourceUrl
        };
    }).filter(reference => reference.book_title || reference.arabic_text) : [];

    const answer = asText(result.answer, 10000);
    if (!answer) throw new Error('Jawaban AI kosong.');
    return {
        answer,
        arabic_keywords: asText(result.arabic_keywords, 1000),
        references
    };
}

app.post('/api/search-kitab', async (req, res) => {
    const email = normalizeEmail(req.body?.user_email);
    const question = String(req.body?.question || '').trim();
    const focus = String(req.body?.focus || 'Semua Mazhab').trim();
    const requestStartedAt = Date.now();
    let requestStage = 'validation';

    if (!isValidEmail(email)) return res.status(400).json({ error: 'Email pengguna tidak valid.' });
    if (question.length < 5 || question.length > 1500) {
        return res.status(400).json({ error: 'Pertanyaan harus berisi 5 sampai 1.500 karakter.' });
    }
    if (!KITAB_FOCUS_OPTIONS.has(focus)) {
        return res.status(400).json({ error: 'Pilihan mazhab atau bidang tidak valid.' });
    }

    try {
        requestStage = 'access-check';
        if (!await requireKitabSubscription(req, res, email)) return;

        const messages = [
            {
                role: 'system',
                content: [
                    'Anda asisten riset kitab turats untuk pembelajaran Islam berbahasa Indonesia, bukan pemberi fatwa mengikat.',
                    'Jawab ringkas (maksimal 250 kata), berimbang, dan sebutkan bila ada perbedaan pendapat.',
                    'Jangan mengarang kutipan Arab, kitab, pengarang, juz, halaman, atau tautan.',
                    'Berikan maksimal 2 rujukan hanya bila yakin; jika tidak, references harus [].',
                    'Kembalikan JSON valid saja dengan schema: {"answer":"...","arabic_keywords":"...","references":[{"book_title":"...","author":"...","author_death":"...","madhhab":"...","volume":"...","page":"...","arabic_text":"...","translation":"...","explanation":"...","source_url":"https://shamela.ws/..."}]}.',
                    'Jangan mengklaim kutipan atau tautan telah diverifikasi bila tidak. Kosongkan data rujukan yang tidak diketahui.'
                ].join(' ')
            },
            {
                role: 'user',
                content: `Fokus: ${focus}\nPertanyaan: ${question}`
            }
        ];
        requestStage = 'ai-provider';
        const aiContent = await callAiChatCompletion(messages);
        const result = parseKitabAiResponse(aiContent);
        requestStage = 'save-search-log';
        const { error: logError } = await supabaseAdmin
            .from('kitab_search_logs')
            .insert([{
                user_email: email,
                question,
                arabic_keywords: result.arabic_keywords,
                answer: result.answer,
                references_json: result.references
            }]);
        if (logError) throw logError;

        return res.json({ question, focus, ...result });
    } catch (error) {
        console.error(
            `Pencarian kitab gagal pada tahap ${requestStage} setelah ${Date.now() - requestStartedAt}ms:`,
            error?.name || 'Error',
            error?.message || error
        );
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return res.status(502).json({
            error: isTimeout
                ? 'Layanan AI membutuhkan waktu terlalu lama. Coba lagi dengan pertanyaan yang lebih singkat.'
                : error.message || 'Pencarian kitab gagal diproses. Silakan coba kembali.'
        });
    }
});

app.get('/api/search-kitab-history', async (req, res) => {
    const email = normalizeEmail(req.query.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Email pengguna tidak valid.' });

    try {
        if (!await requireKitabSubscription(req, res, email)) return;

        const requestedLimit = Number.parseInt(String(req.query.limit || '20'), 10);
        const limit = Number.isFinite(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
        const { data, error } = await supabaseAdmin
            .from('kitab_search_logs')
            .select('id, question, arabic_keywords, answer, references_json, created_at')
            .eq('user_email', email)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return res.json({ history: data || [] });
    } catch (error) {
        console.error('Riwayat pencarian kitab gagal dimuat:', error);
        return res.status(500).json({ error: 'Riwayat pencarian belum dapat dimuat.' });
    }
});

// ================= ENDPOINT TRANSAKSI & FOLLOW-UP WA =================

// Endpoint 1: Membuat Transaksi Midtrans & Mengirim WA Follow-Up Pembayaran
app.post('/api/create-transaction', async (req, res) => {
    try {
        const { course_id, price, user_id, user_email } = req.body;
        const cleanEmail = normalizeEmail(user_email);
        if (course_id === KITAB_COURSE_ID) {
            if (!isValidEmail(cleanEmail)) {
                return res.status(400).json({ error: 'Email pengguna tidak valid.' });
            }
            if (!getAuthenticatedOtpSession(req, cleanEmail)) {
                return res.status(401).json({ error: 'Silakan masuk dengan kode OTP sebelum berlangganan.' });
            }
        }
        const orderId = 'NUQTHAH-' + Date.now();
        
        const cleanPrice = course_id === KITAB_COURSE_ID
            ? KITAB_SUBSCRIPTION_PRICE
            : parseInt(String(price).replace(/[^0-9]/g, '')) || 10000;

        const { data: userData } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('email', cleanEmail || user_email)
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
                email: cleanEmail || 'student@nuqthah.com',
                phone: studentWa
            },
            callbacks: {
                finish: getLearningUrl(course_id)
            }
        };

        let transaction = await snap.createTransaction(parameter);

        const { error: transactionError } = await supabaseAdmin.from('transactions').insert([{
            order_id: orderId,
            user_id: user_id || userData?.id || null,
            user_email: cleanEmail || null,
            course_id: course_id,
            gross_amount: cleanPrice,
            status: 'pending',
            snap_token: transaction.token,
            created_at: new Date().toISOString()
            // payment_type dibiarkan null dulu sampai siswa memilih metode bayar di Midtrans
        }]);
        if (transactionError) throw transactionError;

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
            expires_at: null,
            finish_url: getLearningUrl(course_id)
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
            .select('order_id, user_id, status, payment_type, gross_amount, snap_token')
            .eq('user_email', email)
            .eq('course_id', courseId)
            .in('status', ['pending', 'success'])
            .order('created_at', { ascending: false })
            .limit(10);

        if (transactionsError) throw transactionsError;

        for (const transaction of transactions || []) {
            if (transaction.status === 'success') {
                const accessGranted = await grantTransactionAccessSafely({
                    userId: transaction.user_id,
                    userEmail: email,
                    courseId,
                    orderId: transaction.order_id
                });
                return res.json({ active: false, status: 'success', access_granted: accessGranted });
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

                const accessGranted = await grantTransactionAccessSafely({
                    userId: transaction.user_id,
                    userEmail: email,
                    courseId,
                    orderId: transaction.order_id
                });
                return res.json({ active: false, status: 'success', access_granted: accessGranted });
            }

            const isActive = status === 'pending' &&
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
                    token: transaction.snap_token || null,
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
            .select('order_id, user_id, user_email, course_id, status')
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
            const accessGranted = await grantTransactionAccessSafely({
                userId: transaction.user_id,
                userEmail: email,
                courseId,
                orderId
            });
            return res.json({ active: false, status: 'success', access_granted: accessGranted, expires_at: null });
        }

        const midtransStatus = await snap.transaction.status(orderId);
        const validExpiry = parseMidtransExpiryTime(midtransStatus.expiry_time);
        const isPending = midtransStatus.transaction_status === 'pending';
        const paymentType = midtransStatus.payment_type || null;
        const isActive = isPending && Boolean(paymentType) && (!validExpiry || validExpiry.getTime() > Date.now());
        const isSuccessful = ['capture', 'settlement'].includes(midtransStatus.transaction_status) &&
            (midtransStatus.fraud_status === 'accept' || !midtransStatus.fraud_status);

        if (isSuccessful) {
            const { error } = await supabaseAdmin
                .from('transactions')
                .update({ status: 'success', payment_type: paymentType })
                .eq('order_id', orderId);
            if (error) throw error;

            const accessGranted = await grantTransactionAccessSafely({
                userId: transaction.user_id,
                userEmail: email,
                courseId,
                orderId
            });
            return res.json({
                active: false,
                status: 'success',
                access_granted: accessGranted,
                expires_at: null
            });
        }

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

                await grantTransactionAccessSafely({
                    userId: trx.user_id || userData?.id || null,
                    userEmail: trx.user_email,
                    courseId: trx.course_id,
                    orderId
                });

                if (!wasAlreadySuccess && studentWa) {
                    const formattedRupiah = 'Rp ' + new Intl.NumberFormat('id-ID').format(trx.gross_amount || 0);
                    let groupLinksMessage = '';
                    try {
                        const groupLinks = await getPurchasedWhatsAppGroupLinks(trx.course_id, courseData);
                        if (groupLinks.length > 0) {
                            groupLinksMessage = `\n\nLink grup WhatsApp materi:\n${groupLinks.map(group => `📲 *${group.title}:* ${group.url}`).join('\n')}`;
                        }
                    } catch (groupLinkError) {
                        console.error('[WHATSAPP GROUP LINKS] Gagal memuat link grup materi:', groupLinkError.message);
                    }
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
${groupLinksMessage}

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

        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            throw new Error('Pengiriman email belum dikonfigurasi.');
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + OTP_TTL_MS);

        const { error: otpErr } = await supabaseAdmin
            .from('otps')
            .insert([{ email, code: otpCode, expires_at: expiresAt, used: false }]);

        if (otpErr) throw otpErr;

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
                    <p style="color: #6b7280; font-size: 12px;">Kode ini berlaku selama 60 detik. Jangan berikan kode ini kepada siapa pun.</p>
                </div>
            `
        });

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

        if (oErr || !otpData || new Date(otpData.expires_at) <= new Date()) {
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

        res.json({
            success: true,
            user: userData,
            session_token: createOtpSessionToken(normalizeEmail(userData.email), userData.id)
        });
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
module.exports.config = { maxDuration: 60 };
