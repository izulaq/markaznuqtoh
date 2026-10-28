const MAX_PDF_SIZE = 4 * 1024 * 1024;
const GDRIVE_SCRIPT_URL = process.env.GDRIVE_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzDLSShbz7Zpj9SSvmMIMtTYOcX4NzU0zsBtDzpcJlmq3mpFdZKmvoOR_7ndhlG1bzB/exec';

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-Upload-Provider');
}

function sendError(res, status, message) {
    return res.status(status).json({ error: message });
}

async function readRequestBody(req) {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_PDF_SIZE) {
            const error = new Error('PDF melebihi batas upload 4 MB.');
            error.status = 413;
            throw error;
        }
        chunks.push(buffer);
    }

    return Buffer.concat(chunks, size);
} 

module.exports = async function uploadGoogleDrive(req, res) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method === 'GET') {
        return res.status(200).json({
            status: 'ready',
            provider: 'GDRIVE',
            uploadMode: 'binary',
            maxFileBytes: MAX_PDF_SIZE
        });
    }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST, OPTIONS');
        return sendError(res, 405, 'Metode request tidak didukung.');
    }
    if (req.headers['x-upload-provider'] !== 'GDRIVE') {
        return sendError(res, 400, 'Konfigurasi penyedia upload tidak valid.');
    }
    if (req.headers['content-type'] !== 'application/pdf') {
        return sendError(res, 400, 'Content-Type harus application/pdf.');
    }

    let fileName;
    try {
        const header = req.headers['x-file-name'];
        fileName = decodeURIComponent(Array.isArray(header) ? header[0] || '' : header || '');
    } catch (error) {
        return sendError(res, 400, 'Nama file tidak valid.');
    }
    if (!fileName.toLowerCase().endsWith('.pdf')) {
        return sendError(res, 400, 'Hanya file PDF yang dapat diunggah.');
    }
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_SIZE) {
        return sendError(res, 413, 'PDF melebihi batas upload 4 MB.');
    }

    let fileBuffer;
    try {
        fileBuffer = await readRequestBody(req);
    } catch (error) {
        if (error.status === 413) {
            return sendError(res, 413, error.message);
        }
        console.error('Failed to read PDF upload request:', error);
        return sendError(res, 400, 'Request PDF tidak dapat dibaca.');
    }

    if (fileBuffer.length > MAX_PDF_SIZE) {
        return sendError(res, 413, 'PDF melebihi batas upload 4 MB.');
    }
    if (fileBuffer.length === 0 || !fileBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        return sendError(res, 400, 'Ukuran atau format file PDF tidak valid (maksimal 4 MB).');
    }

    try {
        const uploadResponse = await fetch(GDRIVE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
                fileName: fileName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180),
                mimeType: 'application/pdf',
                base64: fileBuffer.toString('base64')
            })
        });
        const responseText = await uploadResponse.text();
        let uploadResult;
        try {
            uploadResult = JSON.parse(responseText);
        } catch (error) {
            console.error('Google Drive upload returned non-JSON response:', error.message);
            return sendError(res, 502, 'Google Drive tidak mengembalikan respons upload yang valid.');
        }

        if (!uploadResponse.ok || uploadResult?.success === false || uploadResult?.error) {
            const message = uploadResult?.error || 'Google Drive gagal menyimpan file.';
            console.error('Google Drive upload failed:', message);
            return sendError(res, 502, message);
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
            return sendError(res, 502, 'Google Drive tidak mengembalikan ID file yang valid.');
        }

        return res.status(200).json({
            fileId,
            name: typeof file.name === 'string' ? file.name : fileName,
            viewUrl: `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`,
            downloadUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
        });
    } catch (error) {
        console.error('Google Drive upload error:', error);
        return sendError(res, 502, 'Tidak dapat menghubungi layanan Google Drive.');
    }
};
