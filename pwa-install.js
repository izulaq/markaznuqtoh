(function () {
    let deferredInstallPrompt = null;
    let appInstalled = false;

    const styles = document.createElement('style');
    styles.textContent = `
        #pwa-floating-actions {
            position: fixed;
            right: max(1rem, env(safe-area-inset-right));
            bottom: max(1rem, env(safe-area-inset-bottom));
            z-index: 999998;
            display: flex;
            align-items: flex-end;
            gap: 0.6rem;
            pointer-events: none;
        }
        #pwa-floating-actions.has-access-action {
            flex-direction: row;
        }
        #pwa-floating-actions.above-mini-player {
            bottom: calc(1rem + var(--pwa-mini-player-height, 200px) + 0.75rem + env(safe-area-inset-bottom));
        }
        #pwa-floating-actions[hidden],
        #pwa-install-button[hidden],
        #pwa-access-action[hidden] { display: none; }
        #pwa-access-action {
            position: relative;
            pointer-events: auto;
        }
        #pwa-access-button,
        #pwa-install-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            border: 0;
            border-radius: 9999px;
            padding: 0.8rem 0.95rem;
            color: #fff;
            font: 700 0.875rem/1.2 system-ui, sans-serif;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
            cursor: pointer;
            white-space: nowrap;
            pointer-events: auto;
        }
        #pwa-install-button {
            background: #0f4a3a;
        }
        #pwa-install-button:hover { background: #17634e; }
        #pwa-access-button { background: #c9a227; }
        #pwa-access-button:hover { background: #ad861b; }
        #pwa-install-button:focus-visible,
        #pwa-access-button:focus-visible,
        #pwa-install-close:focus-visible {
            outline: 3px solid #c9a227;
            outline-offset: 3px;
        }
        #pwa-install-help[hidden] { display: none; }
        #pwa-secure-payment {
            position: absolute;
            right: 0;
            bottom: calc(100% + 0.65rem);
            width: max-content;
            max-width: min(17rem, calc(100vw - 2rem));
            padding: 0.65rem 0.8rem;
            border: 1px solid #dce9e3;
            border-radius: 0.85rem;
            background: #fff;
            color: #234b36;
            box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14);
            font: 600 0.72rem/1.4 system-ui, sans-serif;
            pointer-events: none;
        }
        #pwa-secure-payment::after {
            position: absolute;
            right: 1.15rem;
            bottom: -0.35rem;
            width: 0.65rem;
            height: 0.65rem;
            border-right: 1px solid #dce9e3;
            border-bottom: 1px solid #dce9e3;
            background: #fff;
            content: "";
            transform: rotate(45deg);
        }
        #pwa-secure-payment strong {
            display: block;
            margin-bottom: 0.1rem;
            font-size: 0.75rem;
        }
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
        @media (max-width: 380px) {
            #pwa-floating-actions { right: max(0.55rem, env(safe-area-inset-right)); gap: 0.4rem; }
            #pwa-access-button,
            #pwa-install-button { gap: 0.35rem; padding: 0.72rem 0.7rem; font-size: 0.75rem; }
            #pwa-secure-payment { font-size: 0.68rem; }
        }
        .pwa-access-source-hidden { display: none !important; }
        @media (max-width: 640px) {
            body.pwa-has-bottom-actions {
                padding-bottom: calc(10rem + env(safe-area-inset-bottom)) !important;
            }
            #pwa-floating-actions.has-access-action {
                left: 0;
                right: 0;
                bottom: 0;
                width: 100%;
                box-sizing: border-box;
                align-items: stretch;
                gap: 0;
                padding-bottom: env(safe-area-inset-bottom);
                background: #fff;
                box-shadow: 0 -6px 24px rgba(15, 23, 42, 0.14);
            }
            #pwa-floating-actions.has-access-action #pwa-access-action {
                flex: 1 1 0;
                min-width: 0;
            }
            #pwa-floating-actions.has-access-action #pwa-access-button {
                width: 100%;
                height: 100%;
                min-height: 3.5rem;
                border-radius: 0;
            }
            #pwa-floating-actions.has-access-action #pwa-install-button {
                width: auto;
                flex: 0 0 auto;
                padding: 0 0.85rem;
                min-height: 3.5rem;
                border-radius: 0;
            }
            #pwa-floating-actions.has-access-action #pwa-secure-payment {
                right: 0.6rem;
                bottom: calc(100% + 0.65rem);
            }
        }
    `;
    document.head.appendChild(styles);

    const floatingActions = document.createElement('div');
    floatingActions.id = 'pwa-floating-actions';
    floatingActions.hidden = true;

    const accessAction = document.createElement('div');
    accessAction.id = 'pwa-access-action';
    accessAction.hidden = true;
    accessAction.innerHTML = `
        <div id="pwa-secure-payment" role="note">
            <strong><i class="fas fa-shield-halved" aria-hidden="true"></i> Secure Payment</strong>
            Pembayaran diproses dengan aman melalui Midtrans.
        </div>
        <button id="pwa-access-button" type="button" aria-label="Buka akses materi">
            <i class="fas fa-lock-open" aria-hidden="true"></i>
            <span id="pwa-access-label">Buka Akses Sekarang</span>
        </button>
    `;

    const button = document.createElement('button');
    button.id = 'pwa-install-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Instal Nuqthah sebagai aplikasi');
    button.innerHTML = '<i class="fas fa-download" aria-hidden="true"></i><span>Instal</span>';
    floatingActions.append(accessAction, button);

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

    document.body.append(floatingActions, help);

    const closeButton = document.getElementById('pwa-install-close');
    const description = document.getElementById('pwa-install-description');
    const steps = document.getElementById('pwa-install-steps');
    const accessButton = document.getElementById('pwa-access-button');
    const accessLabel = document.getElementById('pwa-access-label');
    let updateScheduled = false;
    let hiddenInlineAccessButton = null;

    function hideInstallButton() {
        floatingActions.hidden = true;
        document.body.classList.remove('pwa-has-bottom-actions');
    }

    function isInstalled() {
        return appInstalled ||
            window.matchMedia('(display-mode: standalone)').matches ||
            navigator.standalone === true;
    }

    function findVisibleAccessButton() {
        const candidates = [
            document.getElementById('practice-access-button'),
            document.getElementById('course-access-button')
        ];
        return candidates.find(candidate =>
            candidate &&
            window.getComputedStyle(candidate).visibility !== 'hidden' &&
            (candidate.getClientRects().length > 0 ||
                (candidate === hiddenInlineAccessButton &&
                    candidate.isConnected &&
                    candidate.parentElement?.getClientRects().length > 0))
        ) || null;
    }

    function isCheckoutModalOpen() {
        return ['checkout-modal', 'otp-modal'].some(id => {
            const modal = document.getElementById(id);
            return modal &&
                !modal.classList.contains('hidden') &&
                modal.getClientRects().length > 0;
        });
    }

    function updateFloatingActions() {
        updateScheduled = false;
        const installed = isInstalled();
        const modalOpen = isCheckoutModalOpen();
        const target = installed || modalOpen ? null : findVisibleAccessButton();
        if (hiddenInlineAccessButton &&
            (installed || !hiddenInlineAccessButton.isConnected || hiddenInlineAccessButton !== target)) {
            hiddenInlineAccessButton.classList.remove('pwa-access-source-hidden');
            hiddenInlineAccessButton = null;
        }
        if (target?.id === 'practice-access-button' && !installed) {
            target.classList.add('pwa-access-source-hidden');
            hiddenInlineAccessButton = target;
        }
        accessAction.hidden = !target;
        button.hidden = installed;
        floatingActions.hidden = installed || modalOpen || (!target && button.hidden);
        floatingActions.classList.toggle('has-access-action', Boolean(target) && !installed && !modalOpen);
        const miniPlayer = document.querySelector('.nuqthah-player-wrapper.is-mini-player');
        const isDesktopLayout = window.matchMedia('(min-width: 641px)').matches;
        const shouldLiftAbovePlayer = Boolean(miniPlayer) && isDesktopLayout &&
            !installed && !modalOpen && !floatingActions.hidden;
        floatingActions.classList.toggle('above-mini-player', shouldLiftAbovePlayer);
        if (shouldLiftAbovePlayer) {
            const playerHeight = `${miniPlayer.getBoundingClientRect().height}px`;
            if (floatingActions.style.getPropertyValue('--pwa-mini-player-height') !== playerHeight) {
                floatingActions.style.setProperty('--pwa-mini-player-height', playerHeight);
            }
        } else if (floatingActions.style.getPropertyValue('--pwa-mini-player-height')) {
            floatingActions.style.removeProperty('--pwa-mini-player-height');
        }
        document.body.classList.toggle(
            'pwa-has-bottom-actions',
            Boolean(target) && !installed && !modalOpen && window.matchMedia('(max-width: 640px)').matches
        );

        if (target) {
            const originalLabel = target.querySelector('#practice-access-label, #course-access-label')?.textContent.trim() || '';
            const isSmallScreen = window.matchMedia('(max-width: 380px)').matches;
            accessLabel.textContent = /lanjutkan/i.test(originalLabel)
                ? (isSmallScreen ? 'Lanjut Bayar' : 'Lanjutkan Pembayaran')
                : (isSmallScreen ? 'Buka Akses' : 'Buka Akses Sekarang');
            accessButton.setAttribute(
                'aria-label',
                isSmallScreen ? 'Buka akses materi' : 'Buka akses materi sekarang'
            );
        }
    }

    function scheduleFloatingActionsUpdate() {
        if (updateScheduled) return;
        updateScheduled = true;
        window.requestAnimationFrame(updateFloatingActions);
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

    accessButton.addEventListener('click', () => {
        const target = findVisibleAccessButton();
        if (target) {
            target.click();
        } else {
            scheduleFloatingActionsUpdate();
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
        appInstalled = true;
        deferredInstallPrompt = null;
        hideInstallButton();
    });

    window.addEventListener('resize', scheduleFloatingActionsUpdate);
    window.addEventListener('pageshow', scheduleFloatingActionsUpdate);
    const displayModeQuery = window.matchMedia('(display-mode: standalone)');
    if (displayModeQuery.addEventListener) {
        displayModeQuery.addEventListener('change', scheduleFloatingActionsUpdate);
    } else {
        displayModeQuery.addListener(scheduleFloatingActionsUpdate);
    }
    new MutationObserver(scheduleFloatingActionsUpdate).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style']
    });
    scheduleFloatingActionsUpdate();
})();
