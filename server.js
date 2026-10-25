const express = require('express');
const cors = require('cors');
require('dotenv').config();
const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();

app.use(cors());
app.use(express.json());

// Route pengecekan status server di browser
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Server Backend Nuqthah Learning Center Aktif!'
    });
});

// Inisialisasi Supabase dengan Service Role Key
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Inisialisasi Midtrans Snap API Client
let snap = new midtransClient.Snap({
    isProduction: false,
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

// ================= HELPER: PARSE BUNDLING PAKET =================
function parseBundleIdsFromLink(rawLink) {
    const str = String(rawLink || '');
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

        let parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: cleanPrice
            },
            customer_details: {
                first_name: studentName,
                email: user_email || 'student@nuqthah.com',
                phone: studentWa
            }
        };

        let transaction = await snap.createTransaction(parameter);

        await supabaseAdmin.from('transactions').insert([{
            order_id: orderId,
            user_id: user_id || userData?.id || null,
            user_email: user_email || null,
            course_id: course_id,
            gross_amount: cleanPrice,
            status: 'pending'
        }]);

        if (studentWa) {
            const formattedRupiah = 'Rp ' + new Intl.NumberFormat('id-ID').format(cleanPrice);
            const learningUrl = `https://markaz.nuqthahlearning.my.id/halaman_belajar.html?course_id=${course_id}`;

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

        res.json({ token: transaction.token, order_id: orderId });

    } catch (error) {
        console.error('Midtrans Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint 2: Midtrans Webhook Notification (Update Akses Paket/Satuan & Kirim WA Konfirmasi Lunas)
app.post('/api/midtrans-notification', async (req, res) => {
    try {
        let notificationJson = req.body;
        
        let apiClient = new midtransClient.CoreApi({
            isProduction: false,
            serverKey: process.env.MIDTRANS_SERVER_KEY,
            clientKey: process.env.MIDTRANS_CLIENT_KEY
        });

        const statusResponse = await apiClient.transaction.status(notificationJson.order_id);
        
        let orderId = statusResponse.order_id;
        let transactionStatus = statusResponse.transaction_status;
        let fraudStatus = statusResponse.fraud_status;

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
        const learningUrl = `https://markaz.nuqthahlearning.my.id/halaman_belajar.html?course_id=${trx.course_id}`;

        if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
            if (fraudStatus == 'accept' || !fraudStatus) {
                const wasAlreadySuccess = trx.status === 'success';

                await supabaseAdmin
                    .from('transactions')
                    .update({ status: 'success' })
                    .eq('order_id', orderId);

                const { data: existingAccess } = await supabaseAdmin
                    .from('user_access')
                    .select('id')
                    .eq('order_id', orderId)
                    .limit(1);

                if (!existingAccess || existingAccess.length === 0) {
                    const bundledIds = parseBundleIdsFromLink(courseData?.link);
                    const allCourseIdsToGrant = Array.from(new Set([trx.course_id, ...bundledIds]));

                    const accessRows = allCourseIdsToGrant.map(cid => ({
                        user_id: trx.user_id || userData?.id || null,
                        user_email: trx.user_email || null,
                        course_id: cid,
                        order_id: orderId
                    }));

                    await supabaseAdmin.from('user_access').insert(accessRows);
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
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            const wasAlreadyFailed = trx.status === 'failed';

            await supabaseAdmin
                .from('transactions')
                .update({ status: 'failed' })
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

// Endpoint 3: Kirim Kode OTP ke Email (& WhatsApp jika terdaftar)
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

        console.log(`[OTP SYSTEM] Kode verifikasi untuk ${email} adalah: ${otpCode}`);

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

// Endpoint 4: Verifikasi Kode OTP
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

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server Nuqthah berjalan di port ${PORT}`);
    });
}

module.exports = app;
