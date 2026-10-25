const express = require('express');
const cors = require('cors');
require('dotenv').config();
const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();

// Konfigurasi CORS komprehensif yang otomatis menangani OPTIONS
const corsOptions = {
    origin: ['https://markaznuqthahlearning.my.id', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Inisialisasi Supabase dengan Service Role Key
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

// Endpoint 1: Membuat Transaksi & Mendapatkan Snap Token Midtrans
app.post('/api/create-transaction', async (req, res) => {
    try {
        const { course_id, price, user_id, user_email } = req.body;
        const orderId = 'NUQTHAH-' + Date.now();
        
        const cleanPrice = parseInt(String(price).replace(/[^0-9]/g, '')) || 10000;

        let parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: cleanPrice
            },
            customer_details: {
                email: user_email || 'student@nuqthah.com'
            }
        };

        let transaction = await snap.createTransaction(parameter);

        await supabaseAdmin.from('transactions').insert([{
            order_id: orderId,
            user_id: user_id || null,
            user_email: user_email || null,
            course_id: course_id,
            gross_amount: cleanPrice,
            status: 'pending'
        }]);

        res.json({ token: transaction.token, order_id: orderId });

    } catch (error) {
        console.error('Midtrans Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint 2: Midtrans Webhook Notification
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

        if (transactionStatus == 'capture' || transactionStatus == 'settlement') {
            if (fraudStatus == 'accept' || !fraudStatus) {
                await supabaseAdmin.from('transactions').update({ status: 'success' }).eq('order_id', orderId);

                const { data: trx } = await supabaseAdmin.from('transactions').select('*').eq('order_id', orderId).single();
                
                if (trx) {
                    await supabaseAdmin.from('user_access').insert([{
                        user_id: trx.user_id || null,
                        user_email: trx.user_email || null,
                        course_id: trx.course_id,
                        order_id: orderId
                    }]);
                }
            }
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            await supabaseAdmin.from('transactions').update({ status: 'failed' }).eq('order_id', orderId);
        }

        res.status(200).json({ status: 'OK' });
    } catch (error) {
        console.error('Notification Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ================= ROUTE AUTENTIKASI & OTP (MULTI-DEVICE) =================

// Endpoint 3: Kirim Kode OTP ke Email
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
            return res.status(404).json({ success: false, error: 'Email belum terdaftar. Silakan lakukan pendaftaran melalui tombol Buka Akses Penuh.' });
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

        res.json({ success: true, message: 'Kode OTP berhasil dikirim ke email.' });
    } catch (err) {
        console.error('Error send-otp:', err);
        res.status(500).json({ success: false, error: 'Gagal mengirim email OTP: ' + err.message });
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

// Konfigurasi port lokal vs Vercel
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server Nuqthah berjalan di port ${PORT}`);
    });
}

module.exports = app;
