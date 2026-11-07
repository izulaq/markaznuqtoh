(function () {
    let deferredInstallPrompt = null;

    const styles = document.createElement('style');
    styles.textContent = `
        #pwa-install-button {
            position: fixed;
            right: max(1rem, env(safe-area-inset-right));
            bottom: max(1rem, env(safe-area-inset-bottom));
            z-index: 999998;
            display: inline-flex;
            align-items: center;
            gap: 0.55rem;
            border: 0;
            border-radius: 9999px;
            padding: 0.8rem 1rem;
            background: #0f4a3a;
            color: #fff;
            font: 700 0.875rem/1.2 system-ui, sans-serif;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
            cursor: pointer;
        }
        #pwa-install-button:hover { background: #17634e; }
        #pwa-install-button:focus-visible,
        #pwa-install-close:focus-visible {
            outline: 3px solid #c9a227;
            outline-offset: 3px;
        }
        #pwa-install-button[hidden],
        #pwa-install-help[hidden] { display: none; }
        #pwa-install-help {
            position: fixed;
            inset: 0;
            z-index: 999999;
            display: grid;
            place-items: center;
            padding: 1rem;
            background: rgba(15, 23, 42, 0.64);
            font-family: system-ui, sans-serif;
        }
        #pwa-install-card {
            width: min(100%, 25rem);
            border-radius: 1rem;
            padding: 1.25rem;
            background: #fff;
            color: #1f2937;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.28);
        }
        #pwa-install-card h2 {
            margin: 0 2rem 0.5rem 0;
            color: #0f4a3a;
            font-size: 1.15rem;
            font-weight: 700;
        }
        #pwa-install-card p,
        #pwa-install-card li { font-size: 0.9rem; line-height: 1.5; }
        #pwa-install-steps { margin: 0.75rem 0 1rem; padding-left: 1.4rem; }
        #pwa-install-close {
            float: right;
            border: 0;
            border-radius: 0.5rem;
            padding: 0.4rem 0.65rem;
            background: #f3f4f6;
            color: #374151;
            font-weight: 600;
            cursor: pointer;
        }
    `;
    document.head.appendChild(styles);

    const button = document.createElement('button');
    button.id = 'pwa-install-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Instal Nuqthah sebagai aplikasi');
    button.innerHTML = '<span aria-hidden="true">↓</span><span>Instal Aplikasi</span>';

    const help = document.createElement('div');
    help.id = 'pwa-install-help';
    help.hidden = true;
    help.setAttribute('role', 'dialog');
    help.setAttribute('aria-modal', 'true');
    help.setAttribute('aria-labelledby', 'pwa-install-title');
    help.innerHTML = `
        <section id="pwa-install-card">
            <button id="pwa-install-close" type="button">Tutup</button>
            <h2 id="pwa-install-title">Instal Nuqthah</h2>
            <p id="pwa-install-description"></p>
            <ol id="pwa-install-steps"></ol>
        </section>
    `;

    document.body.append(button, help);

    const closeButton = document.getElementById('pwa-install-close');
    const description = document.getElementById('pwa-install-description');
    const steps = document.getElementById('pwa-install-steps');

    function hideInstallButton() {
        button.hidden = true;
    }

    function isInstalled() {
        return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    }

    function getInstallInstructions() {
        const userAgent = navigator.userAgent || '';
        const isIOS = /iPad|iPhone|iPod/.test(userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const isAndroid = /Android/i.test(userAgent);
        const isLemur = /Lemur/i.test(userAgent);

        if (isIOS) {
            return {
                description: 'Di iPhone atau iPad, instalasi dilakukan melalui Safari dan perlu dikonfirmasi oleh Anda.',
                steps: [
                    'Buka situs ini di Safari.',
                    'Ketuk tombol Bagikan (ikon kotak dengan panah ke atas).',
                    'Pilih “Tambahkan ke Layar Utama”, lalu ketuk “Tambah”.'
                ]
            };
        }
        if (isAndroid) {
            if (isLemur) {
                return {
                    description: 'Lemur hanya dapat menampilkan instalasi langsung jika versi browser mendukung pemasangan PWA. Jika dialog tidak muncul, coba menu Lemur.',
                    steps: [
                        'Buka menu Lemur (ikon tiga titik).',
                        'Pilih “Tambahkan ke layar utama” atau “Instal aplikasi”, jika tersedia.',
                        'Konfirmasi pemasangan. Jika pilihan tersebut tidak tersedia, buka halaman ini di Chrome lalu tekan tombol Instal Aplikasi.'
                    ]
                };
            }
            return {
                description: 'Jika dialog instalasi tidak muncul, gunakan menu browser untuk menambahkan aplikasi.',
                steps: [
                    'Buka menu browser (ikon tiga titik).',
                    'Pilih “Instal aplikasi” atau “Tambahkan ke layar utama”.',
                    'Konfirmasi pemasangan pada dialog browser.'
                ]
            };
        }
        return {
            description: 'Browser ini tidak menyediakan dialog instalasi otomatis untuk halaman ini.',
            steps: [
                'Gunakan Chrome atau Microsoft Edge pada komputer.',
                'Buka menu browser atau ikon instalasi di bilah alamat.',
                'Pilih “Instal Nuqthah” dan konfirmasi.'
            ]
        };
    }

    function openInstallHelp() {
        const instructions = getInstallInstructions();
        description.textContent = instructions.description;
        steps.replaceChildren(...instructions.steps.map(text => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
        }));
        help.hidden = false;
        closeButton.focus();
    }

    function closeInstallHelp() {
        help.hidden = true;
        button.focus();
    }

    button.addEventListener('click', async () => {
        if (!deferredInstallPrompt) {
            openInstallHelp();
            return;
        }

        const installPrompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        button.disabled = true;
        try {
            await installPrompt.prompt();
            await installPrompt.userChoice;
        } catch (error) {
            console.error('Dialog instalasi Nuqthah gagal dibuka:', error);
            openInstallHelp();
        } finally {
            button.disabled = false;
        }
    });

    closeButton.addEventListener('click', closeInstallHelp);
    help.addEventListener('click', event => {
        if (event.target === help) closeInstallHelp();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !help.hidden) closeInstallHelp();
    });

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferredInstallPrompt = event;
    });
    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        hideInstallButton();
    });

    if (isInstalled()) hideInstallButton();
})();
