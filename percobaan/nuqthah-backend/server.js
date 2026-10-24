const express = require('express');
const cors = require('cors');
require('dotenv').config();
const midtransClient = require('midtrans-client');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Inisialisasi Supabase dengan Service Role Key (untuk bypass RLS saat backend mencatat database)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Inisialisasi Midtrans Snap API Client (Ganti isProduction menjadi true jika sudah live)
let snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

// Endpoint 1: Membuat Transaksi & Mendapatkan Snap Token Midtrans
app.post('/api/create-transaction', async (req, res) => {
    try {
        const { course_id, price, user_id, user_email } = req.body;
        const orderId = 'NUQTHAH-' + Date.now();
        
        // Bersihkan string harga dari format rupiah (cth: "Rp 90.000" -> 90000)
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

        // Buat transaksi ke Midtrans Snap
        let transaction = await snap.createTransaction(parameter);

        // Catat transaksi berstatus 'pending' ke tabel transactions di Supabase
        await supabase.from('transactions').insert([{
            order_id: orderId,
            user_id: user_id || null,
            course_id: course_id,
            gross_amount: cleanPrice,
            status: 'pending'
        }]);

        // Kirim token kembali ke frontend
        res.json({ token: transaction.token, order_id: orderId });

    } catch (error) {
        console.error('Midtrans Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint 2: Midtrans Webhook Notification (Otomatis buka akses saat bayar sukses)
app.post('/api/midtrans-notification', async (req, res) => {
    try {
        let notificationJson = req.body;
        
        // Verifikasi status notifikasi menggunakan Core API Midtrans
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
                // Pembayaran Sukses! Update status tabel transactions menjadi 'success'
                await supabase.from('transactions').update({ status: 'success' }).eq('order_id', orderId);

                // Ambil data transaksi untuk mengetahui user_id dan course_id
                const { data: trx } = await supabase.from('transactions').select('*').eq('order_id', orderId).single();
                
                if (trx) {
                    // Masukkan data ke tabel user_access agar materi terbuka secara permanen
                    await supabase.from('user_access').insert([{
                        user_id: trx.user_id,
                        course_id: trx.course_id,
                        order_id: orderId
                    }]);
                }
            }
        } else if (transactionStatus == 'cancel' || transactionStatus == 'deny' || transactionStatus == 'expire') {
            await supabase.from('transactions').update({ status: 'failed' }).eq('order_id', orderId);
        }

        res.status(200).json({ status: 'OK' });
    } catch (error) {
        console.error('Notification Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server Nuqthah berjalan di port ${process.env.PORT || 3000}`);
});